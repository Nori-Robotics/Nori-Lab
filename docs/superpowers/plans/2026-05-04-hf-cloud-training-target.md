# HF Cloud Training Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Hugging Face Jobs (`hf jobs`) as a training target on the Training page, with HF Cloud as the default and Local as fallback. Users select a flavor from a dropdown showing live prices fetched from `HfApi.list_jobs_hardware()`. Final policies upload to the user's HF account when training completes.

**Architecture:** New `HfCloudJobRunner` implementing the existing `JobRunner` Protocol in [app/jobs.py](../../../app/jobs.py). Internally drives `huggingface_hub.HfApi` (`run_job`, `cancel_job`, `fetch_job_logs`, `inspect_job`). The official `huggingface/lerobot-gpu:latest` Docker image is used directly — no bootstrap install needed, lerobot is pre-baked. `JobRegistry` widens its `start()` API to accept a target spec and dispatches to the right runner. New `TargetCard` React component drives selection.

**Tech Stack:** Python 3.10+, FastAPI, Pydantic, `huggingface_hub` (already a transitive dep), React 18 + Vite + TypeScript + shadcn/ui (already in [frontend/](../../../frontend/)).

**Spec:** [docs/superpowers/specs/2026-05-04-hf-cloud-training-target-design.md](../specs/2026-05-04-hf-cloud-training-target-design.md)

**Testing approach:** This project has no pytest harness ([CLAUDE.md](../../../CLAUDE.md): "There is no test suite"). Each task verifies via `python -c` smoke checks for backend logic, `curl` for endpoints, and manual `lelab --dev` exercises for UI. End-to-end is verified in Task 14 with a real HF job.

---

### Task 1: Add Hub-upload fields to `TrainingRequest` and honour them in `build_training_command`

**Why:** The HF Cloud runner needs to set `--policy.push_to_hub true` and `--policy.repo_id <user>/<slug>`, but [training.py:109](../../../app/training.py) hardcodes `--policy.push_to_hub false`. The fields don't exist on `TrainingRequest` yet, so we add them first.

**Files:**
- Modify: `app/training.py`

- [ ] **Step 1: Add the two fields to `TrainingRequest`**

In `app/training.py`, in the `TrainingRequest` Pydantic model, add these two fields right after `policy_use_amp: bool = False` (around line 62):

```python
    # Hub upload (set by HfCloudJobRunner; not exposed in the form)
    policy_push_to_hub: bool = False
    policy_repo_id: Optional[str] = None
```

- [ ] **Step 2: Replace the hardcoded push_to_hub line in `build_training_command`**

In `app/training.py`, find this block (around line 107-109):

```python
    # LeRobot defaults push_to_hub=True and then demands --policy.repo_id.
    # Keep training local by default; uploading is a deliberate action.
    cmd.extend(["--policy.push_to_hub", "false"])
```

Replace with:

```python
    # LeRobot defaults push_to_hub=True and demands --policy.repo_id when so.
    # Local jobs keep it off; HF Cloud jobs flip it on via the runner.
    cmd.extend(["--policy.push_to_hub", "true" if request.policy_push_to_hub else "false"])
    if request.policy_push_to_hub and request.policy_repo_id:
        cmd.extend(["--policy.repo_id", request.policy_repo_id])
```

- [ ] **Step 3: Smoke-check that the argv is right for both modes**

Run from the repo root:

```bash
.venv/bin/python -c "
from app.training import TrainingRequest, build_training_command
req_local = TrainingRequest(dataset_repo_id='nrabault/example')
req_cloud = TrainingRequest(
    dataset_repo_id='nrabault/example',
    policy_push_to_hub=True,
    policy_repo_id='nrabault/act-example',
)
local = build_training_command(req_local, 'outputs/x')
cloud = build_training_command(req_cloud, 'outputs/x')
assert '--policy.push_to_hub' in local and local[local.index('--policy.push_to_hub')+1] == 'false'
assert '--policy.push_to_hub' in cloud and cloud[cloud.index('--policy.push_to_hub')+1] == 'true'
assert '--policy.repo_id' in cloud and cloud[cloud.index('--policy.repo_id')+1] == 'nrabault/act-example'
assert '--policy.repo_id' not in local
print('OK')
"
```

Expected: prints `OK`.

- [ ] **Step 4: Commit**

```bash
git add app/training.py
git commit -m "feat(training): add policy_push_to_hub/repo_id fields for Hub upload"
```

---

### Task 2: Widen `JobRecord` with HF Cloud fields

**Why:** Persisted job records need to remember the runner kind and HF-specific identifiers so the registry can re-attach across uvicorn reloads and the frontend can render the badge / "View on Hub" link.

**Files:**
- Modify: `app/jobs.py:42-56`

- [ ] **Step 1: Edit `JobRecord` to widen `runner` and add HF fields**

In `app/jobs.py`, find the `JobRecord` class (around line 42-56) and replace it with:

```python
class JobRecord(BaseModel):
    id: str
    name: str
    state: JobState
    config: TrainingRequest
    output_dir: str
    started_at: float
    ended_at: Optional[float] = None
    exit_code: Optional[int] = None
    error_message: Optional[str] = None
    metrics: TrainingMetrics = TrainingMetrics()
    runner: Literal["local", "hf_cloud"] = "local"
    # PID of the detached subprocess (local runner only); survives uvicorn
    # --reload so a fresh registry can re-attach by tailing the log file.
    process_pid: Optional[int] = None
    # HF Jobs identifiers (hf_cloud runner only)
    hf_job_id: Optional[str] = None
    hf_flavor: Optional[str] = None
    hf_repo_id: Optional[str] = None
```

- [ ] **Step 2: Smoke-check that old job.json files still load**

Run from the repo root:

```bash
.venv/bin/python -c "
from app.jobs import JobRecord
from app.training import TrainingRequest
# Simulate an old job.json that lacks the new fields
old = {
    'id': 'x', 'name': 'x', 'state': 'done',
    'config': TrainingRequest(dataset_repo_id='a/b').model_dump(),
    'output_dir': 'outputs/train/x', 'started_at': 0.0,
}
r = JobRecord.model_validate(old)
assert r.runner == 'local'
assert r.hf_job_id is None and r.hf_flavor is None and r.hf_repo_id is None
print('OK')
"
```

Expected: prints `OK`. (Confirms backwards compatibility — old persisted records still load.)

- [ ] **Step 3: Commit**

```bash
git add app/jobs.py
git commit -m "feat(jobs): widen JobRecord with runner kind and HF Cloud fields"
```

---

### Task 3: Create `app/runners/` package with `HfCloudJobRunner` skeleton

**Why:** Establish the new file with the class boundaries first; subsequent tasks fill in `start`, `log-tailing`, and `lifecycle`.

**Files:**
- Create: `app/runners/__init__.py`
- Create: `app/runners/hf_cloud.py`

- [ ] **Step 1: Create the package init**

```bash
mkdir -p app/runners
```

Then create `app/runners/__init__.py` with content:

```python
"""Job runner implementations.

The local runner currently lives in app/jobs.py for historical reasons; this
package is for newer / out-of-process runners. They all satisfy the JobRunner
Protocol declared in app/jobs.py.
"""
from .hf_cloud import HfCloudJobRunner

__all__ = ["HfCloudJobRunner"]
```

- [ ] **Step 2: Create `app/runners/hf_cloud.py` with skeleton class**

Create `app/runners/hf_cloud.py`:

```python
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
```

- [ ] **Step 3: Smoke-check that the class satisfies the Protocol**

```bash
.venv/bin/python -c "
from app.jobs import JobRunner
from app.runners.hf_cloud import HfCloudJobRunner
from app.jobs import TrainingMetrics
from pathlib import Path
r = HfCloudJobRunner(TrainingMetrics(), Path('/tmp/x.jsonl'), 'a10g-small')
assert isinstance(r, JobRunner)
print('OK')
"
```

Expected: prints `OK`. (Confirms structural typing matches the protocol.)

- [ ] **Step 4: Commit**

```bash
git add app/runners/
git commit -m "feat(runners): add HfCloudJobRunner skeleton implementing JobRunner protocol"
```

---

### Task 4: Implement `HfCloudJobRunner.start`

**Why:** Submit the training job to HF Jobs. Resolve the user, mutate the config to enable Hub upload, dispatch via `HfApi.run_job`, store the returned `hf_job_id`, and persist the log file handle.

**Files:**
- Modify: `app/runners/hf_cloud.py`

- [ ] **Step 1: Add username/slug helper imports**

At the top of `app/runners/hf_cloud.py`, the existing imports are sufficient. We will use `_SLUG_RE` from `app.training` and `_generate_job_id` is not exported — instead derive the slug inline since we already have `job_id`.

- [ ] **Step 2: Implement `start`**

In `app/runners/hf_cloud.py`, replace the `start` method body with:

```python
    def start(self, job_id: str, config: TrainingRequest, output_dir: str) -> None:
        if self._hf_job_id is not None:
            raise RuntimeError("HfCloudJobRunner already started")

        token = get_token()
        if not token:
            raise RuntimeError(
                "HF token not found. Run 'hf auth login' before launching cloud jobs."
            )

        whoami = self._api.whoami()
        username = whoami.get("name") if isinstance(whoami, dict) else None
        if not username:
            raise RuntimeError("Could not resolve HF username from whoami()")

        # Mutate the config so build_training_command emits the right flags.
        # The mutated config is what gets persisted in JobRecord.config, so
        # the historical record reflects what actually ran.
        config.policy_push_to_hub = True
        # job_id is already a unique slug like "act_dataset_2026-05-04_10-22-03".
        config.policy_repo_id = f"{username}/{job_id}"

        argv = build_training_command(config, output_dir)
        logger.info("Submitting HF Cloud job %s on %s: %s",
                    job_id, self._flavor, " ".join(argv))

        # Open the persistent log sink — same shape as LocalJobRunner.
        self._log_file_path.parent.mkdir(parents=True, exist_ok=True)
        self._log_file = self._log_file_path.open("a", buffering=1)

        job = self._api.run_job(
            image=LEROBOT_IMAGE,
            command=argv,
            flavor=self._flavor,
            environment={"HF_TOKEN": token},
        )
        self._hf_job_id = job.id

        # Log-tailing thread is started in Task 5.
```

- [ ] **Step 3: Smoke-check (no live HF call)**

The submission requires real HF credentials. For now just verify the runner imports cleanly and rejects start without a token. From the repo root:

```bash
.venv/bin/python -c "
import os
# Force-empty token paths
os.environ.pop('HF_TOKEN', None)
from unittest.mock import patch
from pathlib import Path
from app.jobs import TrainingMetrics
from app.runners.hf_cloud import HfCloudJobRunner
from app.training import TrainingRequest

with patch('app.runners.hf_cloud.get_token', return_value=None):
    r = HfCloudJobRunner(TrainingMetrics(), Path('/tmp/x.jsonl'), 'a10g-small')
    try:
        r.start('jid', TrainingRequest(dataset_repo_id='a/b'), 'outputs/x')
    except RuntimeError as e:
        assert 'HF token not found' in str(e)
        print('OK')
"
```

Expected: prints `OK`.

- [ ] **Step 4: Commit**

```bash
git add app/runners/hf_cloud.py
git commit -m "feat(runners): implement HfCloudJobRunner.start (run_job submission)"
```

---

### Task 5: Implement log-tailing thread + lifecycle (`is_running`, `returncode`, `stop`)

**Why:** The runner needs to (a) stream stdout from the cloud job into our log file and metrics parser, and (b) report state transitions so the registry watchdog can finalise.

**Files:**
- Modify: `app/runners/hf_cloud.py`

- [ ] **Step 1: Add the log-tailing thread spawn at the end of `start`**

In `app/runners/hf_cloud.py`, append to the end of `start` (after `self._hf_job_id = job.id`):

```python
        self._tail_thread = threading.Thread(
            target=self._tail_loop, name=f"hf-job-{job_id}-logs", daemon=True
        )
        self._tail_thread.start()
```

- [ ] **Step 2: Implement `_tail_loop`**

In `app/runners/hf_cloud.py`, add this method below `start`:

```python
    def _tail_loop(self) -> None:
        """Consume HfApi.fetch_job_logs until it returns. Tee each line to
        the log file and the in-memory queue, and update metrics inline.

        On disconnect, retry up to 3 times with exponential backoff. After
        that, exit the loop; the registry watchdog will catch the eventual
        terminal state via inspect_job.
        """
        assert self._hf_job_id is not None
        retries = 0
        while not self._stop_event.is_set():
            try:
                for raw in self._api.fetch_job_logs(self._hf_job_id):
                    if self._stop_event.is_set():
                        return
                    stripped = raw.rstrip()
                    if not stripped:
                        continue
                    parse_metrics_into(stripped, self._metrics)
                    log_line = LogLine(timestamp=time.time(), message=stripped)
                    if self._log_file is not None:
                        try:
                            self._log_file.write(log_line.model_dump_json() + "\n")
                        except Exception as exc:  # pragma: no cover
                            logger.exception("Error writing HF log: %s", exc)
                    if self._log_queue.qsize() >= 1000:
                        try:
                            self._log_queue.get_nowait()
                        except Empty:
                            pass
                    self._log_queue.put(log_line)
                # Generator returned cleanly — job ended.
                return
            except Exception as exc:
                retries += 1
                if retries > 3:
                    logger.warning(
                        "HF log tail gave up after 3 retries for job %s: %s",
                        self._hf_job_id, exc,
                    )
                    return
                logger.info("HF log tail disconnected (retry %d/3): %s", retries, exc)
                self._stop_event.wait(2 ** retries)
```

Also at the end of `_tail_loop`, after the method body, add a `finally` cleanup. Actually, restructure with try/finally so the log file always closes:

Replace the method with this final form:

```python
    def _tail_loop(self) -> None:
        """Consume HfApi.fetch_job_logs until it returns. Tee each line to
        the log file and the in-memory queue, and update metrics inline.

        On disconnect, retry up to 3 times with exponential backoff. After
        that, exit the loop; the registry watchdog will catch the eventual
        terminal state via inspect_job.
        """
        assert self._hf_job_id is not None
        try:
            retries = 0
            while not self._stop_event.is_set():
                try:
                    for raw in self._api.fetch_job_logs(self._hf_job_id):
                        if self._stop_event.is_set():
                            return
                        stripped = raw.rstrip()
                        if not stripped:
                            continue
                        parse_metrics_into(stripped, self._metrics)
                        log_line = LogLine(timestamp=time.time(), message=stripped)
                        if self._log_file is not None:
                            try:
                                self._log_file.write(log_line.model_dump_json() + "\n")
                            except Exception as exc:  # pragma: no cover
                                logger.exception("Error writing HF log: %s", exc)
                        if self._log_queue.qsize() >= 1000:
                            try:
                                self._log_queue.get_nowait()
                            except Empty:
                                pass
                        self._log_queue.put(log_line)
                    # Generator returned cleanly — job ended.
                    return
                except Exception as exc:
                    retries += 1
                    if retries > 3:
                        logger.warning(
                            "HF log tail gave up after 3 retries for job %s: %s",
                            self._hf_job_id, exc,
                        )
                        return
                    logger.info("HF log tail disconnected (retry %d/3): %s",
                                retries, exc)
                    self._stop_event.wait(2 ** retries)
        finally:
            if self._log_file is not None:
                try:
                    self._log_file.close()
                except Exception:
                    pass
                self._log_file = None
```

- [ ] **Step 3: Implement `is_running`, `returncode`, `stop`**

In `app/runners/hf_cloud.py`, replace the three placeholder methods with:

```python
    def is_running(self) -> bool:
        if self._hf_job_id is None:
            return False
        try:
            info = self._api.inspect_job(self._hf_job_id)
        except Exception as exc:
            logger.warning("inspect_job failed for %s: %s", self._hf_job_id, exc)
            return False
        # Status values from huggingface_hub: QUEUED, RUNNING, COMPLETED,
        # FAILED, CANCELLED. We treat queued/running as alive.
        status = getattr(info, "status", None)
        status_str = str(status).upper() if status is not None else ""
        if status_str in {"QUEUED", "RUNNING"}:
            return True
        # Cache the terminal status so returncode() can map it without
        # re-calling the API.
        self._terminal_status = status_str
        return False

    def returncode(self) -> Optional[int]:
        if self._hf_job_id is None:
            return None
        # If we haven't yet observed the terminal status, ask now.
        if self._terminal_status is None and self.is_running():
            return None
        if self._terminal_status is None:
            return None
        return 0 if self._terminal_status == "COMPLETED" else 1

    def stop(self) -> None:
        if self._hf_job_id is None:
            return
        self._stop_event.set()
        try:
            self._api.cancel_job(self._hf_job_id)
        except Exception as exc:
            # Already-completed jobs may 404; that's fine. Watchdog will
            # finalise on its next tick.
            logger.info("cancel_job(%s) ignored: %s", self._hf_job_id, exc)
```

- [ ] **Step 4: Smoke-check the runner with a mocked `HfApi`**

```bash
.venv/bin/python -c "
from unittest.mock import MagicMock, patch
from pathlib import Path
import tempfile
from app.jobs import TrainingMetrics
from app.runners.hf_cloud import HfCloudJobRunner
from app.training import TrainingRequest

with tempfile.TemporaryDirectory() as td:
    log_path = Path(td) / 'log.jsonl'
    with patch('app.runners.hf_cloud.HfApi') as MockApi, \
         patch('app.runners.hf_cloud.get_token', return_value='hf_dummy'):
        api = MockApi.return_value
        api.whoami.return_value = {'name': 'tester'}
        fake_job = MagicMock()
        fake_job.id = 'hfjob_abc'
        api.run_job.return_value = fake_job
        # No log lines for this smoke
        api.fetch_job_logs.return_value = iter([])
        # Make inspect_job return COMPLETED so lifecycle resolves cleanly.
        info = MagicMock()
        info.status = 'COMPLETED'
        api.inspect_job.return_value = info

        r = HfCloudJobRunner(TrainingMetrics(), log_path, 'a10g-small')
        cfg = TrainingRequest(dataset_repo_id='ds/x')
        r.start('test_job_id', cfg, 'outputs/x')
        # Wait briefly for tail thread to run.
        import time
        time.sleep(0.2)
        assert r.hf_job_id() == 'hfjob_abc'
        assert cfg.policy_push_to_hub is True
        assert cfg.policy_repo_id == 'tester/test_job_id'
        # Lifecycle: not running, returncode 0
        assert r.is_running() is False
        assert r.returncode() == 0
        api.run_job.assert_called_once()
        kwargs = api.run_job.call_args.kwargs
        assert kwargs['image'] == 'huggingface/lerobot-gpu:latest'
        assert kwargs['flavor'] == 'a10g-small'
        assert kwargs['environment'] == {'HF_TOKEN': 'hf_dummy'}
        print('OK')
"
```

Expected: prints `OK`.

- [ ] **Step 5: Commit**

```bash
git add app/runners/hf_cloud.py
git commit -m "feat(runners): implement log tail and lifecycle for HfCloudJobRunner"
```

---

### Task 6: Wire `HfCloudJobRunner` into `JobRegistry.start` via a target spec

**Why:** Today `JobRegistry.start(config)` always builds a `LocalJobRunner`. Make it dispatch to the right runner based on a target spec passed by the caller.

**Files:**
- Modify: `app/jobs.py:470-518` (the `start` method) and the `_runners` dict typing.

- [ ] **Step 1: Add a `JobTarget` Pydantic model at the top of `app/jobs.py`**

In `app/jobs.py`, after the existing `JobState` typedef (around line 25), insert:

```python
class JobTarget(BaseModel):
    """Where a job should run. `local` ⇒ LocalJobRunner. `hf_cloud` requires
    a non-empty `flavor` from HfApi.list_jobs_hardware()."""
    runner: Literal["local", "hf_cloud"] = "local"
    flavor: Optional[str] = None
```

- [ ] **Step 2: Widen `_runners` typing and import the new runner**

In `app/jobs.py`, near the top of the file (after the existing imports), add:

```python
from .runners.hf_cloud import HfCloudJobRunner
```

Then find the `_runners: Dict[str, LocalJobRunner] = {}` line (around line 446 in the `__init__`) and change it to:

```python
        self._runners: Dict[str, JobRunner] = {}
```

- [ ] **Step 3: Modify `JobRegistry.start` to accept and act on a target spec**

In `app/jobs.py`, find the `start` method (around line 470) and replace its full body with:

```python
    def start(self, config: TrainingRequest, target: Optional[JobTarget] = None) -> JobRecord:
        target = target or JobTarget()
        if target.runner == "hf_cloud" and not target.flavor:
            raise ValueError("flavor is required when runner is hf_cloud")

        with self._lock:
            for r in self._records.values():
                if r.state == "running":
                    raise JobAlreadyRunningError(r.id)

            job_id = _generate_job_id(config.policy_type, config.dataset_repo_id)
            job_dir = _job_dir(self._output_root, job_id)
            lerobot_output_dir = str(job_dir / "run")
            name = f"{config.policy_type.upper()} · {config.dataset_repo_id}"
            record = JobRecord(
                id=job_id,
                name=name,
                state="running",
                config=config,
                output_dir=lerobot_output_dir,
                started_at=time.time(),
                runner=target.runner,
                hf_flavor=target.flavor,
            )

            job_dir.mkdir(parents=True, exist_ok=True)
            self._records[job_id] = record
            self._persist(record, force=True)

            log_path = _job_log_path(self._output_root, job_id)
            if target.runner == "local":
                runner = LocalJobRunner(record.metrics, log_file_path=log_path)
            else:
                runner = HfCloudJobRunner(record.metrics, log_path, target.flavor)

            try:
                runner.start(job_id, config, lerobot_output_dir)
            except Exception as exc:
                logger.exception("Failed to start runner for job %s", job_id)
                record.state = "failed"
                record.ended_at = time.time()
                record.error_message = f"Failed to start runner: {exc}"
                self._persist(record, force=True)
                raise

            # Capture runner-specific identifiers.
            if target.runner == "local":
                record.process_pid = runner.pid()
            else:
                record.hf_job_id = runner.hf_job_id()
                # config was mutated by HfCloudJobRunner.start to set
                # policy_repo_id; mirror it onto the record for the UI.
                record.hf_repo_id = config.policy_repo_id

            self._persist(record, force=True)
            self._runners[job_id] = runner
            return record
```

- [ ] **Step 4: Smoke-check that local-mode behaviour is unchanged**

The existing flow uses `start(config)` (no target). It must still work.

```bash
.venv/bin/python -c "
import inspect
from app.jobs import JobRegistry
sig = inspect.signature(JobRegistry.start)
params = list(sig.parameters.keys())
assert params == ['self', 'config', 'target']
assert sig.parameters['target'].default is None
print('OK')
"
```

Expected: prints `OK`.

- [ ] **Step 5: Commit**

```bash
git add app/jobs.py
git commit -m "feat(jobs): JobRegistry.start dispatches to local or hf_cloud runner"
```

---

### Task 7: Reattach to in-flight HF Cloud jobs across uvicorn reloads

**Why:** With `--reload`, the registry rebuilds. Local jobs already reattach via `TailingJobRunner` (PID tail). HF Cloud jobs need an analogous path: re-spawn the log-tailing thread, point it at the existing `hf_job_id`.

**Files:**
- Modify: `app/jobs.py` (the `_load_from_disk` method).
- Modify: `app/runners/hf_cloud.py` to expose a `reattach()` entry point.

- [ ] **Step 1: Add a `reattach()` method to `HfCloudJobRunner`**

In `app/runners/hf_cloud.py`, add this method right after `start`:

```python
    def reattach(self, hf_job_id: str) -> None:
        """Take over an existing HF job after a process restart.

        Skips submission; just opens the log file in append mode and starts
        the log-tailing thread. The watchdog will finalise based on inspect_job.
        """
        if self._hf_job_id is not None:
            raise RuntimeError("HfCloudJobRunner already started")
        self._hf_job_id = hf_job_id
        self._log_file_path.parent.mkdir(parents=True, exist_ok=True)
        self._log_file = self._log_file_path.open("a", buffering=1)
        self._tail_thread = threading.Thread(
            target=self._tail_loop, name=f"hf-job-{hf_job_id}-logs-reattach", daemon=True
        )
        self._tail_thread.start()
```

- [ ] **Step 2: Extend `_load_from_disk` to handle `runner == "hf_cloud"`**

In `app/jobs.py`, find the `_load_from_disk` method (around line 593) and find this block:

```python
            if record.state == "running":
                # Was the subprocess detached and is it still alive? If yes,
                # re-attach via tailing the persisted log file. The watchdog
                # will finalise the record when the pid eventually dies.
                pid = record.process_pid
                if pid is not None and _pid_alive(pid):
                    logger.info(
                        "Re-attaching to detached job %s (pid %d)", record.id, pid
                    )
                    runner = TailingJobRunner(
                        record.metrics,
                        _job_log_path(self._output_root, record.id),
                        pid,
                    )
                    runner.start_tailing()
                    self._runners[record.id] = runner
                else:
                    record.state = "interrupted"
                    if record.ended_at is None:
                        record.ended_at = time.time()
                    self._write_meta(record)
            self._records[record.id] = record
```

Replace with:

```python
            if record.state == "running":
                if record.runner == "local":
                    pid = record.process_pid
                    if pid is not None and _pid_alive(pid):
                        logger.info(
                            "Re-attaching to detached local job %s (pid %d)",
                            record.id, pid,
                        )
                        runner = TailingJobRunner(
                            record.metrics,
                            _job_log_path(self._output_root, record.id),
                            pid,
                        )
                        runner.start_tailing()
                        self._runners[record.id] = runner
                    else:
                        record.state = "interrupted"
                        if record.ended_at is None:
                            record.ended_at = time.time()
                        self._write_meta(record)
                elif record.runner == "hf_cloud" and record.hf_job_id and record.hf_flavor:
                    # Probe HF for the live status before reattaching.
                    try:
                        from huggingface_hub import HfApi
                        info = HfApi().inspect_job(record.hf_job_id)
                        status = str(getattr(info, "status", "")).upper()
                    except Exception as exc:
                        logger.warning(
                            "inspect_job failed during reattach for %s: %s",
                            record.id, exc,
                        )
                        status = ""
                    if status in {"QUEUED", "RUNNING"}:
                        logger.info(
                            "Re-attaching to HF Cloud job %s (hf_job_id=%s)",
                            record.id, record.hf_job_id,
                        )
                        runner = HfCloudJobRunner(
                            record.metrics,
                            _job_log_path(self._output_root, record.id),
                            record.hf_flavor,
                        )
                        runner.reattach(record.hf_job_id)
                        self._runners[record.id] = runner
                    else:
                        record.state = "interrupted"
                        if record.ended_at is None:
                            record.ended_at = time.time()
                        self._write_meta(record)
                else:
                    # Malformed running record — mark interrupted.
                    record.state = "interrupted"
                    if record.ended_at is None:
                        record.ended_at = time.time()
                    self._write_meta(record)
            self._records[record.id] = record
```

- [ ] **Step 3: Smoke-check that re-load handles unknown runner gracefully**

```bash
.venv/bin/python -c "
import json, tempfile
from pathlib import Path
from app.jobs import JobRegistry
from app.training import TrainingRequest

with tempfile.TemporaryDirectory() as td:
    root = Path(td)
    job_dir = root / 'job1'
    job_dir.mkdir()
    rec = {
        'id': 'job1', 'name': 'x', 'state': 'running',
        'config': TrainingRequest(dataset_repo_id='a/b').model_dump(),
        'output_dir': str(job_dir / 'run'),
        'started_at': 0.0,
        'runner': 'hf_cloud',
        # Missing hf_job_id ⇒ should mark interrupted, not crash.
    }
    (job_dir / 'job.json').write_text(json.dumps(rec))
    reg = JobRegistry(root)
    loaded = reg.get('job1')
    assert loaded.state == 'interrupted'
    print('OK')
" 2>&1 | tail -5
```

Expected: prints `OK` (after possibly some warning logs about the malformed record).

- [ ] **Step 4: Commit**

```bash
git add app/jobs.py app/runners/hf_cloud.py
git commit -m "feat(jobs): reattach to HF Cloud jobs across uvicorn reloads"
```

---

### Task 8: Add `GET /jobs/runners/hardware` endpoint

**Why:** Feeds the frontend's TargetCard dropdown with the live flavor catalog + auth state.

**Files:**
- Modify: `app/main.py`

- [ ] **Step 1: Find the existing job-related routes block**

Open `app/main.py` and locate the cluster of `@app.post("/jobs/...")` and `@app.get("/jobs/...")` routes. Pick a location adjacent to `/jobs` listing — pick somewhere logical near the other job-related routes.

- [ ] **Step 2: Add an in-process flavor cache and the new endpoint**

In `app/main.py`, near the top (after existing imports), add:

```python
from huggingface_hub import HfApi, get_token

_flavors_cache: dict = {"data": None, "fetched_at": 0.0}
_FLAVOR_CACHE_TTL_SECONDS = 300.0
```

Then add this route handler somewhere in the jobs section:

```python
@app.get("/jobs/runners/hardware")
def get_runners_hardware():
    """Return HF Jobs flavor catalog + auth state for the TargetCard.

    The flavors list is cached in-process for 5 minutes; whoami is fetched
    fresh each call (cheap; resolves the active HF token).
    """
    token = get_token()
    api = HfApi()
    authenticated = False
    username: Optional[str] = None
    if token:
        try:
            who = api.whoami()
            if isinstance(who, dict) and who.get("name"):
                authenticated = True
                username = who["name"]
        except Exception as exc:
            logger.info("whoami failed: %s", exc)

    if not authenticated:
        return {"authenticated": False, "username": None, "flavors": []}

    now = time.time()
    if (
        _flavors_cache["data"] is None
        or now - _flavors_cache["fetched_at"] > _FLAVOR_CACHE_TTL_SECONDS
    ):
        try:
            hw_list = api.list_jobs_hardware()
        except Exception as exc:
            logger.warning("list_jobs_hardware failed: %s", exc)
            return {"authenticated": True, "username": username, "flavors": []}
        _flavors_cache["data"] = [
            {
                "name": h.name,
                "pretty_name": h.pretty_name,
                "cpu": h.cpu,
                "ram": h.ram,
                "accelerator": h.accelerator,
                "unit_cost_usd": h.unit_cost_usd,
                "unit_label": h.unit_label,
            }
            for h in hw_list
        ]
        _flavors_cache["fetched_at"] = now

    return {
        "authenticated": True,
        "username": username,
        "flavors": _flavors_cache["data"],
    }
```

If `Optional` and `time` aren't imported in `main.py` yet, add them:

```python
import time
from typing import Optional
```

- [ ] **Step 3: Verify the endpoint works**

Start the server in one terminal:

```bash
.venv/bin/lelab
```

In another terminal:

```bash
curl -s http://localhost:8000/jobs/runners/hardware | head -c 500
```

Expected: JSON like `{"authenticated":true,"username":"<you>","flavors":[{"name":"cpu-basic", ...}, ...]}`. Stop the server.

- [ ] **Step 4: Commit**

```bash
git add app/main.py
git commit -m "feat(api): add GET /jobs/runners/hardware for TargetCard dropdown"
```

---

### Task 9: Widen `POST /jobs/training` request body with optional `target`

**Why:** Lets the frontend send `{runner: "hf_cloud", flavor: "a10g-small"}` alongside the training config. Backwards-compatible (omitted target ⇒ local).

**Files:**
- Modify: `app/main.py` (the `POST /jobs/training` handler)
- Modify: `frontend/src/lib/jobsApi.ts` request type (Task 10 covers the frontend types; this task only touches backend)

- [ ] **Step 1: Find the `POST /jobs/training` handler**

In `app/main.py`, locate the `@app.post("/jobs/training")` route. It currently accepts a body of `TrainingRequest` and calls `job_registry.start(request)`.

- [ ] **Step 2: Define a wrapping request body that includes target**

In `app/main.py`, near where `TrainingRequest` is imported, add:

```python
from .jobs import JobTarget

class StartTrainingBody(BaseModel):
    """Wrapping body for POST /jobs/training. Adds optional target spec."""
    config: TrainingRequest
    target: Optional[JobTarget] = None

    @classmethod
    def from_legacy(cls, raw: dict) -> "StartTrainingBody":
        """Accept the old request shape (TrainingRequest fields at top level)
        as well as the new shape ({config: ..., target: ...}).
        """
        if "config" in raw and isinstance(raw["config"], dict):
            return cls.model_validate(raw)
        # Legacy: top-level training fields, no target.
        return cls(config=TrainingRequest.model_validate(raw))
```

If `BaseModel` isn't already imported in `main.py`, add `from pydantic import BaseModel` (it likely already is).

- [ ] **Step 3: Modify the route to accept the wrapping body**

In `app/main.py`, change the route's signature and body. Find the current handler (looks like):

```python
@app.post("/jobs/training")
def start_training_job(request: TrainingRequest):
    ...
    record = job_registry.start(request)
    return record
```

Replace with:

```python
@app.post("/jobs/training")
async def start_training_job(req: Request):
    raw = await req.json()
    body = StartTrainingBody.from_legacy(raw)
    try:
        record = job_registry.start(body.config, body.target)
    except JobAlreadyRunningError as exc:
        raise HTTPException(status_code=409, detail=f"Job already running: {exc}")
    except ValueError as exc:
        # e.g. "flavor is required when runner is hf_cloud"
        raise HTTPException(status_code=400, detail=str(exc))
    return record
```

If `Request` from `fastapi` isn't imported, add it:

```python
from fastapi import Request
```

`HTTPException` and `JobAlreadyRunningError` should already be imported in this file's existing handler — keep those imports.

- [ ] **Step 4: Verify both shapes work via curl**

Start `.venv/bin/lelab` in another terminal. Then (replacing `<dataset>` with any small dataset you have access to, or expect a 4xx for invalid dataset — that's fine, we're checking the request shape parsing):

```bash
# Legacy shape — should reach the registry
curl -s -X POST http://localhost:8000/jobs/training \
  -H "Content-Type: application/json" \
  -d '{"dataset_repo_id":"INVALID/notarealdataset","policy_type":"act","steps":1}' \
  -w "\nHTTP %{http_code}\n"

# New shape with explicit target
curl -s -X POST http://localhost:8000/jobs/training \
  -H "Content-Type: application/json" \
  -d '{"config":{"dataset_repo_id":"INVALID/notarealdataset","policy_type":"act","steps":1},"target":{"runner":"local"}}' \
  -w "\nHTTP %{http_code}\n"

# Bad target — flavor missing for hf_cloud — should 400
curl -s -X POST http://localhost:8000/jobs/training \
  -H "Content-Type: application/json" \
  -d '{"config":{"dataset_repo_id":"INVALID/notarealdataset"},"target":{"runner":"hf_cloud"}}' \
  -w "\nHTTP %{http_code}\n"
```

Expected:
- First two: HTTP 200 (or 5xx if the dataset truly doesn't exist and the subprocess fails fast — either is fine; we're verifying the request shape was accepted, not that training succeeded).
- Third: HTTP 400 with detail `flavor is required when runner is hf_cloud`.

Stop the server. Clean up any leftover job dirs in `outputs/train/` from this smoke (`rm -rf outputs/train/act_INVALID*` if needed).

- [ ] **Step 5: Commit**

```bash
git add app/main.py
git commit -m "feat(api): POST /jobs/training accepts optional target spec"
```

---

### Task 10: Frontend — extend types and add `listRunnerHardware` API helper

**Why:** Plumbing required by the TargetCard component in Task 11.

**Files:**
- Modify: `frontend/src/components/training/types.ts`
- Modify: `frontend/src/lib/jobsApi.ts`

- [ ] **Step 1: Inspect the current `TrainingConfig` type**

Open [frontend/src/components/training/types.ts](../../../frontend/src/components/training/types.ts) and locate the `TrainingConfig` interface. Confirm field names match `Training.tsx`'s usage.

- [ ] **Step 2: Add `target` to `TrainingConfig`**

Add this field to the `TrainingConfig` interface (place it near the top of the field list, since it's first in the form layout):

```ts
  target: { runner: "local" | "hf_cloud"; flavor?: string };
```

- [ ] **Step 3: Add `target` to `TrainingRequest` in jobsApi.ts**

Open [frontend/src/lib/jobsApi.ts](../../../frontend/src/lib/jobsApi.ts) and find the `TrainingRequest` exported type. Add to it:

```ts
  // Optional target for runner dispatch; omitted ⇒ local.
  target?: { runner: "local" | "hf_cloud"; flavor?: string };
```

Also widen `JobRecord` (response shape) with the new fields. Find `JobRecord` and add:

```ts
  runner: "local" | "hf_cloud";
  hf_job_id: string | null;
  hf_flavor: string | null;
  hf_repo_id: string | null;
```

- [ ] **Step 4: Add `listRunnerHardware` and its type**

Append to `frontend/src/lib/jobsApi.ts`:

```ts
export interface RunnerFlavor {
  name: string;
  pretty_name: string;
  cpu: string;
  ram: string;
  accelerator: string | null;
  unit_cost_usd: number;
  unit_label: string;
}

export interface RunnerHardwareResponse {
  authenticated: boolean;
  username: string | null;
  flavors: RunnerFlavor[];
}

export async function listRunnerHardware(
  baseUrl: string,
  fetchWithHeaders: typeof fetch
): Promise<RunnerHardwareResponse> {
  const res = await fetchWithHeaders(`${baseUrl}/jobs/runners/hardware`);
  if (!res.ok) {
    return { authenticated: false, username: null, flavors: [] };
  }
  return res.json();
}
```

- [ ] **Step 5: Update the `startTrainingJob` helper to send the wrapping body**

In `frontend/src/lib/jobsApi.ts`, find `startTrainingJob`. It currently posts the `TrainingRequest` object directly. Change the body shape so the backend gets `{config, target}` when target is present:

```ts
export async function startTrainingJob(
  baseUrl: string,
  fetchWithHeaders: typeof fetch,
  request: TrainingRequest
): Promise<JobRecord> {
  const { target, ...config } = request;
  const body = target ? { config, target } : { config };
  const res = await fetchWithHeaders(`${baseUrl}/jobs/training`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `HTTP ${res.status}`);
  }
  return res.json();
}
```

(If the existing function has a slightly different signature, preserve its outer shape — only change the body construction logic.)

- [ ] **Step 6: Verify frontend type-checks**

The project uses Vite, no test runner. Type-checking happens at build time:

```bash
cd frontend && npm run build 2>&1 | tail -30
```

Expected: build succeeds (or fails only on intentional unused imports — fix those if they appear, otherwise the build is green).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/training/types.ts frontend/src/lib/jobsApi.ts
git commit -m "feat(frontend): add target field types and runner hardware API helper"
```

---

### Task 11: Frontend — `TargetCard` component, render in `ConfigurationTab`

**Why:** The dropdown UI is the centrepiece of this feature. Default selection drives the upsell.

**Files:**
- Create: `frontend/src/components/training/config/TargetCard.tsx`
- Modify: `frontend/src/components/training/ConfigurationTab.tsx`
- Modify: `frontend/src/pages/Training.tsx` (default value, listRunnerHardware fetch)

- [ ] **Step 1: Create `TargetCard.tsx`**

Create `frontend/src/components/training/config/TargetCard.tsx`:

```tsx
import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfigComponentProps } from "../types";
import { RunnerFlavor } from "@/lib/jobsApi";

interface TargetCardProps extends ConfigComponentProps {
  authenticated: boolean;
  flavors: RunnerFlavor[];
  loading: boolean;
}

const formatHourly = (unitCostUsd: number, unitLabel: string): string => {
  // Convert per-minute cost to per-hour for display.
  const hourly = unitLabel === "minute" ? unitCostUsd * 60 : unitCostUsd;
  return `$${hourly.toFixed(2)}/hr`;
};

const formatFlavorLine = (f: RunnerFlavor): string => {
  const accel = f.accelerator ? f.accelerator : f.cpu;
  return `${f.pretty_name} · ${accel} · ${formatHourly(f.unit_cost_usd, f.unit_label)}`;
};

const TargetCard: React.FC<TargetCardProps> = ({
  config,
  updateConfig,
  authenticated,
  flavors,
  loading,
}) => {
  const target = config.target;
  const value =
    target.runner === "local" ? "local" : `hf:${target.flavor ?? ""}`;

  const handleChange = (v: string) => {
    if (v === "local") {
      updateConfig("target", { runner: "local" });
    } else if (v.startsWith("hf:")) {
      const flavor = v.slice("hf:".length);
      updateConfig("target", { runner: "hf_cloud", flavor });
    }
  };

  return (
    <Card className="bg-slate-800/50 border-slate-700 rounded-xl">
      <CardHeader>
        <CardTitle className="text-white">Compute target</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label className="text-slate-300">Run training on</Label>
          <Select value={value} onValueChange={handleChange}>
            <SelectTrigger className="bg-slate-900 border-slate-600 text-white rounded-lg mt-1">
              <SelectValue placeholder={loading ? "Loading…" : "Select target"} />
            </SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-600">
              <SelectItem value="local">Local — your machine (free)</SelectItem>
              {flavors.map((f) => (
                <SelectItem
                  key={f.name}
                  value={`hf:${f.name}`}
                  disabled={!authenticated}
                >
                  {formatFlavorLine(f)}
                  {!authenticated && (
                    <span className="text-amber-300 ml-2 text-xs">
                      log in to HF
                    </span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-slate-500 mt-1">
            Cost shown is per running hour. Final policy uploads to your HF
            account when training completes.
          </p>
        </div>
      </CardContent>
    </Card>
  );
};

export default TargetCard;
```

- [ ] **Step 2: Render `TargetCard` at the top of `ConfigurationTab`**

Open [frontend/src/components/training/ConfigurationTab.tsx](../../../frontend/src/components/training/ConfigurationTab.tsx). It currently renders `EssentialsCard` and `AdvancedCard`. Modify it to also accept and render `TargetCard`:

```tsx
import React from "react";
import EssentialsCard from "./config/EssentialsCard";
import AdvancedCard from "./config/AdvancedCard";
import TargetCard from "./config/TargetCard";
import { ConfigComponentProps } from "./types";
import { DatasetItem } from "@/lib/replayApi";
import { RunnerFlavor } from "@/lib/jobsApi";

interface ConfigurationTabProps extends ConfigComponentProps {
  datasets: DatasetItem[];
  datasetsLoading: boolean;
  authenticated: boolean;
  flavors: RunnerFlavor[];
  hardwareLoading: boolean;
}

const ConfigurationTab: React.FC<ConfigurationTabProps> = ({
  config,
  updateConfig,
  datasets,
  datasetsLoading,
  authenticated,
  flavors,
  hardwareLoading,
}) => (
  <div className="max-w-3xl mx-auto space-y-4">
    <TargetCard
      config={config}
      updateConfig={updateConfig}
      authenticated={authenticated}
      flavors={flavors}
      loading={hardwareLoading}
    />
    <EssentialsCard
      config={config}
      updateConfig={updateConfig}
      datasets={datasets}
      datasetsLoading={datasetsLoading}
    />
    <AdvancedCard config={config} updateConfig={updateConfig} />
  </div>
);

export default ConfigurationTab;
```

(If the existing layout differs slightly, preserve the wrapper styles — only add the `TargetCard` and the new props.)

- [ ] **Step 3: Wire fetch + default selection in `Training.tsx`**

Open [frontend/src/pages/Training.tsx](../../../frontend/src/pages/Training.tsx) and modify `ConfigurationMode`:

a) Add the import at the top:

```tsx
import { listRunnerHardware, RunnerFlavor } from "@/lib/jobsApi";
```

b) Add the default `target` field in the `useState` initial config (around line 92):

```tsx
    target: { runner: "local" },
```

(Make this the first field; we'll auto-flip to HF Cloud after the hardware fetch resolves.)

c) Add new state for hardware:

```tsx
  const [authenticated, setAuthenticated] = useState<boolean>(false);
  const [flavors, setFlavors] = useState<RunnerFlavor[]>([]);
  const [hardwareLoading, setHardwareLoading] = useState(true);
```

d) Add the fetching `useEffect` near the existing fetch effects:

```tsx
  useEffect(() => {
    setHardwareLoading(true);
    listRunnerHardware(baseUrl, fetchWithHeaders)
      .then((data) => {
        setAuthenticated(data.authenticated);
        setFlavors(data.flavors);
        // Default-select HF Cloud + a10g-small when authed and present.
        if (
          data.authenticated &&
          data.flavors.some((f) => f.name === "a10g-small")
        ) {
          setTrainingConfig((prev) => ({
            ...prev,
            target: { runner: "hf_cloud", flavor: "a10g-small" },
          }));
        }
      })
      .catch(() => {
        setAuthenticated(false);
        setFlavors([]);
      })
      .finally(() => setHardwareLoading(false));
  }, [baseUrl, fetchWithHeaders]);
```

e) Pass the new props down to `ConfigurationTab`:

```tsx
        <ConfigurationTab
          config={trainingConfig}
          updateConfig={updateConfig}
          datasets={datasets}
          datasetsLoading={datasetsLoading}
          authenticated={authenticated}
          flavors={flavors}
          hardwareLoading={hardwareLoading}
        />
```

f) Update `configToRequest` to pass `target` through:

In `Training.tsx`, find `configToRequest` (around line 57) and add:

```tsx
    target: c.target,
```

to the returned object.

- [ ] **Step 4: Manual verification**

```bash
.venv/bin/lelab --dev
```

Open the browser to the Training page (e.g. <http://localhost:8080/training>). Verify:

1. The "Compute target" card appears at the top of the Configuration form.
2. The dropdown lists "Local — your machine (free)" plus all HF flavors with prices (e.g. *"Nvidia A10G small · 1× A10G (24 GB) · $1.00/hr"*).
3. If you're logged into HF, the dropdown shows `Nvidia A10G small …` selected by default.
4. Switching between Local and HF flavors updates the selection; refresh and the user sees the same default re-applied (the page state resets, this is expected).

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/training/config/TargetCard.tsx \
        frontend/src/components/training/ConfigurationTab.tsx \
        frontend/src/pages/Training.tsx
git commit -m "feat(frontend): TargetCard with live HF flavor catalog and prices"
```

---

### Task 12: Frontend — render `HfAuthBanner` and gate the Start button

**Why:** When unauthed, surface the existing login banner above the form (matches Landing UX) and prevent the user from starting an HF Cloud job without a flavor selected.

**Files:**
- Modify: `frontend/src/pages/Training.tsx`

- [ ] **Step 1: Import `HfAuthBanner`**

In `frontend/src/pages/Training.tsx`, add:

```tsx
import HfAuthBanner from "@/components/landing/HfAuthBanner";
```

- [ ] **Step 2: Render the banner above the form in `ConfigurationMode`**

Find the JSX in `ConfigurationMode` that renders the `<TrainingHeader />` and `<ConfigurationTab .../>`. Insert `<HfAuthBanner />` between them:

```tsx
  return (
    <div className="min-h-screen bg-slate-900 text-white p-4">
      <div className="max-w-7xl mx-auto">
        <TrainingHeader />
        <HfAuthBanner />
        <ConfigurationTab
          config={trainingConfig}
          updateConfig={updateConfig}
          datasets={datasets}
          datasetsLoading={datasetsLoading}
          authenticated={authenticated}
          flavors={flavors}
          hardwareLoading={hardwareLoading}
        />
        ...
```

- [ ] **Step 3: Update `startDisabled` and tooltip for HF Cloud target**

Find the `startDisabled` / `startTooltip` lines in `ConfigurationMode` (around line 194-195). Replace with:

```tsx
  const targetRequiresAuth = trainingConfig.target.runner === "hf_cloud";
  const targetMissingFlavor =
    trainingConfig.target.runner === "hf_cloud" && !trainingConfig.target.flavor;
  const startDisabled =
    isStarting ||
    !trainingConfig.dataset_repo_id.trim() ||
    runningJobExists ||
    (targetRequiresAuth && !authenticated) ||
    targetMissingFlavor;
  const startTooltip = runningJobExists
    ? "Another training is already running"
    : targetRequiresAuth && !authenticated
    ? "Log in to Hugging Face to use cloud compute"
    : targetMissingFlavor
    ? "Select a hardware flavor"
    : undefined;
```

- [ ] **Step 4: Manual verification**

Run `.venv/bin/lelab --dev` and visit the Training page.

a) **Authed case** (`hf auth whoami` succeeds): The auth banner shows the small "Logged in to Hugging Face as <user>" line. The TargetCard defaults to A10G small. Start button is enabled when a dataset is selected.

b) **Unauthed case**: Run `hf auth logout` first. Refresh the page. The auth banner becomes the amber warning card with the login command. The TargetCard's HF rows are greyed out with "log in to HF" hints. The default selection falls back to Local (because the auto-flip in Task 11 only fires when `authenticated`). Selecting an HF flavor disables the Start button with the "Log in to Hugging Face…" tooltip.

After verification: `hf auth login` again to restore your token, then stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Training.tsx
git commit -m "feat(frontend): HfAuthBanner + Start button gating for HF Cloud target"
```

---

### Task 13: Frontend — runner badge + "View on Hub" link in MonitoringMode

**Why:** Once a training is running or finished, the user needs to know which runner ran it and (for HF Cloud) where the policy ended up.

**Files:**
- Modify: `frontend/src/pages/Training.tsx` (the `MonitoringMode` component)

- [ ] **Step 1: Add the badge + link to the header block**

In `frontend/src/pages/Training.tsx`, find the `MonitoringMode` header section (around line 372-394). Locate this block:

```tsx
            <div>
              <h1 className="text-xl font-semibold text-white">{job.name}</h1>
              <p className="text-xs text-slate-400">
                {job.state}
                {job.error_message ? ` — ${job.error_message}` : ""}
              </p>
            </div>
```

Replace with:

```tsx
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold text-white">{job.name}</h1>
                {job.runner === "hf_cloud" ? (
                  <span className="text-xs px-2 py-0.5 rounded bg-amber-900/40 text-amber-200 border border-amber-700">
                    HF · {job.hf_flavor ?? "cloud"}
                  </span>
                ) : (
                  <span className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-200 border border-slate-600">
                    Local
                  </span>
                )}
                {job.runner === "hf_cloud" && job.hf_repo_id && (
                  <a
                    href={`https://huggingface.co/${job.hf_repo_id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-amber-300 hover:text-amber-200 underline"
                  >
                    View on Hub ↗
                  </a>
                )}
              </div>
              <p className="text-xs text-slate-400">
                {job.state}
                {job.error_message ? ` — ${job.error_message}` : ""}
              </p>
            </div>
```

- [ ] **Step 2: Manual verification — Local job shows the slate badge**

Start a local training (any small dataset, low steps). Navigate to `/training/<job_id>`. Confirm the "Local" badge appears next to the job name. The "View on Hub" link must NOT appear.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Training.tsx
git commit -m "feat(frontend): runner badge and View on Hub link in MonitoringMode"
```

---

### Task 14: End-to-end smoke test on a real HF Cloud job

**Why:** This is where we verify everything actually works. The earlier tasks have unit-level smoke checks; this task confirms the whole pipeline with a real (small, cheap) HF job.

**Files:** none modified — this is a verification task only.

- [ ] **Step 1: Pick a small public dataset and pick the cheapest GPU**

Pick a tiny dataset to keep the run short. Recommended: any dataset on the user's HF account with ~5-10 episodes. For the run, set `steps=20` (very short) and pick the `t4-small` flavor (~$0.40/hr) to keep cost minimal.

- [ ] **Step 2: Verify HF auth is fresh**

```bash
.venv/bin/hf auth whoami
```

Expected: prints your username. If not, run `.venv/bin/hf auth login`.

- [ ] **Step 3: Start the server and submit an HF Cloud job from the UI**

```bash
.venv/bin/lelab --dev
```

In the browser:
1. Open the Training page.
2. Verify TargetCard shows "Nvidia A10G small …" as default.
3. Change the dropdown to **t4-small** ("Nvidia T4 small · 1× T4 (16 GB) · $0.40/hr").
4. Choose a small dataset.
5. Set steps to 20 (in the EssentialsCard).
6. Click **Start Training**.

- [ ] **Step 4: Verify the job appears on HF**

While the run is going:

```bash
.venv/bin/hf jobs ps | head -20
```

Expected: a row matching the job we just submitted (image: `huggingface/lerobot-gpu`, status: RUNNING).

- [ ] **Step 5: Verify logs flow into the leLab UI**

In the MonitoringMode page on the frontend, verify:
- The "HF · t4-small" badge shows next to the job name.
- The Logs panel populates with lerobot stdout (dataset loading, training step lines).
- The MonitoringStats panel shows `current_step` increasing.

- [ ] **Step 6: Verify the policy lands on HF Hub at the end**

When the run finishes (a 20-step ACT run on T4 should take a couple of minutes plus image pull):
- The job state in the leLab UI flips to `done`.
- The "View on Hub ↗" link appears in the header.
- Click it. The browser opens the policy repo on huggingface.co (e.g. `https://huggingface.co/<user>/act_<dataset>_<timestamp>`). Verify the repo contains the `pytorch_model.bin` (or equivalent lerobot checkpoint files).

- [ ] **Step 7: Verify the Stop button works**

Submit another short run, then click **Stop** in the UI. Verify:
- Backend logs show `cancel_job(...)` invoked.
- HF Jobs ps shows the job transitioning to CANCELLED.
- leLab record state moves to `failed` or `interrupted` within ~10 seconds.

- [ ] **Step 8: Cleanup**

Delete the HF model repos created during the smoke if they're not wanted (visit each repo's "Settings → Delete this model" page on huggingface.co).

If everything passes, the feature is verified. No commit needed for this task — it is purely manual verification.

---

## Self-Review

**Spec coverage:**

- ✅ Architecture (new `HfCloudJobRunner` implementing `JobRunner` Protocol): Tasks 3-5
- ✅ JobRegistry dispatches by target: Task 6
- ✅ JobRecord widens with `runner`/`hf_*` fields: Task 2
- ✅ Reattach to in-flight HF jobs across uvicorn reloads: Task 7
- ✅ `TrainingRequest` widens with `policy_push_to_hub`/`policy_repo_id`: Task 1
- ✅ `build_training_command` honours the new fields: Task 1
- ✅ Use `huggingface/lerobot-gpu:latest` image, no bootstrap install: Task 4
- ✅ `GET /jobs/runners/hardware` endpoint with 5-min cache: Task 8
- ✅ `POST /jobs/training` accepts optional `target`: Task 9
- ✅ Frontend types + `listRunnerHardware`: Task 10
- ✅ TargetCard at top of ConfigurationTab with cost-aware dropdown: Task 11
- ✅ Default = HF Cloud + `a10g-small` when authed, else Local: Task 11
- ✅ HfAuthBanner renders on Training page; HF rows disabled when unauthed: Tasks 11-12
- ✅ Start button gating for HF Cloud + unauthed / no flavor: Task 12
- ✅ Local/HF badge + "View on Hub" link in MonitoringMode header: Task 13
- ✅ End-to-end smoke verifying push-to-Hub at completion: Task 14
- ✅ Error handling (run_job failure, log disconnect retry, cancel_job 404, unauthed start): covered in Tasks 5/6/9
- ✅ Persistence is unchanged (same `outputs/train/<job_id>/log.jsonl` + `job.json` shapes): implicit in Tasks 2/4/5/6
- ✅ Mutual exclusion of running jobs across runners: Task 6 (existing JobAlreadyRunningError check)

**Out-of-scope items intentionally not in any task** (per spec § Future work / Non-goals):

- Per-step Hub checkpoint pushes
- Multi-GPU DDP flags
- Resume-from-Hub
- Scheduled jobs
- Cost guardrail / budget caps / "you are about to spend $X" dialog
- Custom image input

**Type/signature consistency check:**

- `HfCloudJobRunner.__init__(metrics, log_file_path, flavor)` — used identically in Tasks 3, 4, 5, 6, 7. ✅
- `JobRegistry.start(config, target=None)` — used in Tasks 6, 9. ✅
- `JobTarget(runner, flavor)` — defined Task 6, consumed Tasks 6, 9. ✅
- `RunnerFlavor` shape (name, pretty_name, cpu, ram, accelerator, unit_cost_usd, unit_label) — defined backend (Task 8) and frontend (Task 10), formatted in Task 11. ✅
- `JobRecord.runner / hf_job_id / hf_flavor / hf_repo_id` — defined Task 2, populated Task 6, exposed in API Task 9 (passive — already returned by `record.model_dump()`), consumed frontend Tasks 10, 13. ✅

No unresolved placeholders, contradictions, or undefined references found.
