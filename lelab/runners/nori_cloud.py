# NORI: Additive file. A JobRunner that dispatches training through Nori-Backend instead
# of submitting an HF Job directly. It implements the same JobRunner Protocol as
# HfCloudJobRunner, so a Nori training shows up in the existing job list + "watch training"
# UI with no frontend changes — LeLab's own /jobs/{id} and /jobs/{id}/logs endpoints call
# stream_log_lines()/is_running() on this runner.
#
# Two deliberate differences from HfCloudJobRunner, forced by the Nori architecture:
#
#   1. Config-less dispatch. Nori's POST /training/dispatch takes only {timeout_seconds};
#      the backend decides *what* to train from the customer's uploaded data + consents.
#      The LeLab TrainingRequest is recorded for history but only `timeout` is forwarded.
#
#   2. JWT lifetime. Only the browser can refresh the short-lived Supabase JWT; the Python
#      side cannot. We capture the JWT at construction (valid at dispatch time) and poll
#      logs with it. If it expires mid-run we stop streaming gracefully (the backend job
#      keeps running); the frontend training-history page — which holds a refreshing token —
#      remains the source of truth for long jobs and across LeLab restarts.

from __future__ import annotations

import contextlib
import logging
import threading
import time
from pathlib import Path
from queue import Empty, Queue

from ..jobs import LogLine, TrainingMetrics, extract_wandb_run_url, parse_metrics_into
from ..nori_client import NoriBackendError, NoriClient
from ..train import TrainingRequest

logger = logging.getLogger(__name__)

_LOG_POLL_INTERVAL_S = 2.0
# Ceiling for the exponential backoff applied while Nori-Backend is unreachable.
_MAX_POLL_BACKOFF_S = 30.0
# Give up streaming after this many *consecutive* unreachable/errored polls, so a
# detached or orphaned lelab process doesn't retry (and log) forever when
# Nori-Backend is down. The job keeps running on Nori; the Training history page
# re-attaches with a fresh token.
_MAX_CONSECUTIVE_POLL_FAILURES = 10
# job_status substrings (case-insensitive) that count as a successful terminal run.
_SUCCESS_MARKERS = ("succeed", "success", "complete", "promot", "done")


class NoriCloudJobRunner:
    """Dispatch + watch one Nori-Backend training job. Single-shot."""

    def __init__(
        self,
        metrics: TrainingMetrics,
        log_file_path: Path,
        timeout_seconds: int,
        jwt: str | None,
    ) -> None:
        self._metrics = metrics
        self._log_file_path = log_file_path
        self._timeout_seconds = timeout_seconds
        self._client = NoriClient(jwt=jwt)
        self._job_uuid: str | None = None
        self._hf_job_id: str | None = None
        self._log_queue: Queue[LogLine] = Queue()
        self._poll_thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._log_file = None  # type: ignore[assignment]
        self._terminal_status: str | None = None
        self._terminal_message: str | None = None
        self._wandb_run_url: str | None = None
        self._log_offset = 0

    # -- lifecycle -----------------------------------------------------------------

    # The DispatchRequest fields Nori-Backend honors. Mirrors the frontend's
    # types.ts::HONORED_DISPATCH_KEYS — everything else in TrainingRequest is
    # recorded on the LeLab job record but not forwarded (the backend forces or
    # ignores it). dataset_ref is omitted when None (=> backend uses latest upload).
    _HONORED_KEYS = (
        "policy_type", "steps", "batch_size", "num_workers",
        "seed", "policy_use_amp", "log_freq",
    )

    def _dispatch_body(self, config: TrainingRequest) -> dict:
        body: dict = {"timeout_seconds": self._timeout_seconds}
        for k in self._HONORED_KEYS:
            v = getattr(config, k, None)
            if v is not None:
                body[k] = v
        dataset_ref = getattr(config, "dataset_ref", None)
        if dataset_ref:
            body["dataset_ref"] = dataset_ref
        open_dataset_id = getattr(config, "open_dataset_id", None)
        if open_dataset_id:
            body["open_dataset_id"] = open_dataset_id
        return body

    def start(self, job_id: str, config: TrainingRequest, output_dir: str) -> None:
        del output_dir  # backend owns the run dir; nothing local to write
        if self._job_uuid is not None:
            raise RuntimeError("NoriCloudJobRunner already started")

        self._log_file_path.parent.mkdir(parents=True, exist_ok=True)
        self._log_file = self._log_file_path.open("a", buffering=1)

        dispatch_body = self._dispatch_body(config)
        resp = self._client.dispatch_training(dispatch_body)
        self._job_uuid = resp.get("internal_job_uuid")
        self._hf_job_id = resp.get("hf_job_id")
        self._log_line(
            f"[nori] dispatched training job {self._job_uuid} "
            f"(hf_job_id={self._hf_job_id}, policy={dispatch_body.get('policy_type')}, "
            f"steps={dispatch_body.get('steps')}, timeout={self._timeout_seconds}s)"
        )
        if not self._job_uuid:
            raise RuntimeError(f"Nori dispatch returned no internal_job_uuid: {resp}")

        self._poll_thread = threading.Thread(
            target=self._poll_loop, name=f"nori-job-{job_id}", daemon=True
        )
        self._poll_thread.start()

    def _poll_loop(self) -> None:
        assert self._job_uuid is not None
        failures = 0
        while not self._stop_event.is_set():
            try:
                resp = self._client.get_job_logs(self._job_uuid, since=self._log_offset)
            except NoriBackendError as exc:
                if exc.status_code in (401, 403):
                    self._log_line(
                        "[nori] auth token expired — stopping log streaming. The job "
                        "continues on Nori; watch it on the Training history page."
                    )
                    return
                failures += 1
                # Log the first failure at WARNING, then drop to DEBUG so a
                # persistently-unreachable backend doesn't spam the console every
                # poll (the symptom this guard fixes).
                logger.log(
                    logging.WARNING if failures == 1 else logging.DEBUG,
                    "Nori log poll failed for %s (attempt %d/%d): %s",
                    self._job_uuid,
                    failures,
                    _MAX_CONSECUTIVE_POLL_FAILURES,
                    exc,
                )
                if failures >= _MAX_CONSECUTIVE_POLL_FAILURES:
                    self._log_line(
                        "[nori] Nori-Backend unreachable — stopping log streaming after "
                        f"{failures} consecutive failures. The job continues on Nori; "
                        "watch it on the Training history page."
                    )
                    return
                # Exponential backoff (2s, 4s, 8s, … capped) instead of a tight 2s retry.
                backoff = min(_LOG_POLL_INTERVAL_S * 2 ** (failures - 1), _MAX_POLL_BACKOFF_S)
                if self._stop_event.wait(backoff):
                    return
                continue

            failures = 0
            for raw in resp.get("lines", []):
                stripped = raw.rstrip()
                if not stripped:
                    continue
                parse_metrics_into(stripped, self._metrics)
                if self._wandb_run_url is None:
                    url = extract_wandb_run_url(stripped)
                    if url is not None:
                        self._wandb_run_url = url
                self._emit(LogLine(timestamp=time.time(), message=stripped))

            self._log_offset = resp.get("next_offset", self._log_offset)

            if resp.get("is_terminal"):
                status = str(resp.get("job_status") or "UNKNOWN")
                self._set_terminal(status, status)
                return
            if self._stop_event.wait(_LOG_POLL_INTERVAL_S):
                return

    # -- helpers -------------------------------------------------------------------

    def _set_terminal(self, status: str, message: str | None = None) -> None:
        if self._terminal_status is not None:
            return
        self._terminal_status = status
        if message:
            self._terminal_message = message
        self._stop_event.set()

    def _emit(self, line: LogLine) -> None:
        if self._log_file is not None:
            with contextlib.suppress(Exception):
                self._log_file.write(line.model_dump_json() + "\n")
        if self._log_queue.qsize() >= 1000:
            with contextlib.suppress(Empty):
                self._log_queue.get_nowait()
        self._log_queue.put(line)

    def _log_line(self, message: str) -> None:
        self._emit(LogLine(timestamp=time.time(), message=message))

    # -- JobRunner Protocol --------------------------------------------------------

    def stop(self) -> None:
        # Nori exposes no laptop-side training-cancel; we can only stop streaming.
        self._log_line("[nori] stop requested — laptop cannot cancel a Nori cloud job.")
        self._stop_event.set()

    def is_running(self) -> bool:
        return self._job_uuid is not None and self._terminal_status is None

    def returncode(self) -> int | None:
        if self._terminal_status is None:
            return None
        low = self._terminal_status.lower()
        return 0 if any(m in low for m in _SUCCESS_MARKERS) else 1

    def stream_log_lines(self) -> list[LogLine]:
        out: list[LogLine] = []
        try:
            while True:
                out.append(self._log_queue.get_nowait())
        except Empty:
            pass
        return out

    def wandb_run_url(self) -> str | None:
        return self._wandb_run_url

    def terminal_message(self) -> str | None:
        return self._terminal_message

    # -- Nori identifiers (captured by the registry onto the JobRecord) ------------

    def nori_job_uuid(self) -> str | None:
        return self._job_uuid

    def hf_job_id(self) -> str | None:
        return self._hf_job_id

    def hf_job_url(self) -> str | None:
        return None
