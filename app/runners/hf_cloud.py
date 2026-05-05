"""HF Jobs runner — runs a training as an HF Jobs job on HuggingFace's GPUs.

Uses huggingface/lerobot-gpu:latest as the runtime image (lerobot pre-installed).
Tails logs via HfApi.fetch_job_logs and reuses the existing parse_metrics_into
parser since stdout format is identical to a local lerobot run.
"""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from queue import Empty, Queue
from typing import List, Optional

from huggingface_hub import HfApi, get_token

from ..jobs import LogLine, TrainingMetrics, parse_metrics_into
from ..training import TrainingRequest, build_training_command

logger = logging.getLogger(__name__)

LEROBOT_IMAGE = "huggingface/lerobot-gpu:latest"


class HfCloudJobRunner:
    """Run a training as an HF Jobs job. Single-shot — instantiate per job."""

    def __init__(
        self,
        metrics: TrainingMetrics,
        log_file_path: Path,
        flavor: str,
    ) -> None:
        self._metrics = metrics
        self._log_file_path = log_file_path
        self._flavor = flavor
        self._api = HfApi()
        self._hf_job_id: Optional[str] = None
        self._log_queue: "Queue[LogLine]" = Queue()
        self._tail_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._log_file = None  # type: ignore[assignment]
        # Cached terminal status once the job ends; None while live.
        self._terminal_status: Optional[str] = None

    def start(self, job_id: str, config: TrainingRequest, output_dir: str) -> None:
        raise NotImplementedError("filled in Task 4")

    def stop(self) -> None:
        raise NotImplementedError("filled in Task 5")

    def is_running(self) -> bool:
        raise NotImplementedError("filled in Task 5")

    def returncode(self) -> Optional[int]:
        raise NotImplementedError("filled in Task 5")

    def stream_log_lines(self) -> List[LogLine]:
        out: List[LogLine] = []
        try:
            while True:
                out.append(self._log_queue.get_nowait())
        except Empty:
            pass
        return out

    def hf_job_id(self) -> Optional[str]:
        return self._hf_job_id
