# NORI: Additive file. Phase 2 of the cloud-inference spike (task #38).
#
# Chunk-queue client for a CLOUD VLA endpoint (MolmoAct2-SO100_101 served by our
# own FastAPI server — see cloud_inference/molmoact2_server.py — on a HF Docker
# Space today, an AWS g5 / Modal box tomorrow). This is the laptop-side "client"
# to that endpoint; it is HOST-AGNOSTIC — it only speaks the /act HTTP contract,
# so moving the server HF -> AWS changes one env var (NORI_INFER_URL), nothing here.
#
# WHY A QUEUE. A VLA returns a whole action CHUNK (~30 moves) per call and the
# call is slow (~0.30s warm, ~3.6s on the first CUDA-graph compile) — far too slow
# to run every control tick. So we run it OPEN-LOOP: buffer the chunk and hand the
# browser one action per tick; when the buffer runs low, fire ONE async refill
# (using the latest observation) so the next chunk lands before the buffer drains.
# At 15fps a 30-action chunk is ~2s of motion and a warm refill is ~0.3s, so the
# queue never empties in steady state (the ~6.7x real-time headroom measured on
# the A10G in milestone 1).
#
# The browser is UNCHANGED: it still POSTs {state,images} to /nori/rollout/act and
# gets {action}. lelab just serves that action from the queue instead of a local
# policy. The bearer token stays server-side (never shipped to the browser). Every
# daemon-side safety layer still applies — the only robot-bound artifact is the
# same {type:"control", action:{...}} frame teleop.sendAction() produces.

import json
import logging
import os
import threading
import urllib.request
from collections import deque
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger(__name__)

# Trigger a refill when the buffer falls to this many actions. Must cover the
# refill round-trip: at 15fps, 8 actions ≈ 530ms of motion > ~300ms warm inference.
REFILL_WATERMARK = 8
MAX_QUEUE = 90  # hard cap so a burst of refills can't grow the buffer unbounded
DEFAULT_NUM_STEPS = 10
HEALTH_TIMEOUT = 8.0
ACT_TIMEOUT = 20.0  # first call compiles a CUDA graph (~3.6s); leave slack


class CloudRolloutError(RuntimeError):
    """Raised by serve() when the buffer is empty AND the last refill errored —
    the /act endpoint turns this into a 503 so the browser's consecutive-failure
    watchdog trips and stops the rollout (belt on top of the daemon's braces)."""


# --- MolmoAct2-SO100_101 joint contract (Phase 3 mapping) -------------------
# The model's canonical output order, verbatim from its norm_stats.json
# (metadata_by_tag.so100_so101_molmoact2.action_stats.names). control_mode is
# "absolute joint pose" (degrees), so an action IS a target pose, not a delta.
MOLMOACT2_JOINTS = [
    "shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper",
]
# Per-joint (min, max) from the same norm_stats action_stats — a COARSE reject-
# absurd guard only (the robot daemon still applies the tight physical clamp).
MOLMOACT2_BOUNDS = [
    (-122.61, 179.21),   # shoulder_pan
    (-270.0, 219.64),    # shoulder_lift
    (-269.21, 195.38),   # elbow_flex
    (-125.77, 178.95),   # wrist_flex
    (-269.91, 269.82),   # wrist_roll
    (-31.57, 119.41),    # gripper
]


def arm_keys(arm: str) -> list[str]:
    """The 6 Nori telemetry/action keys for one arm, ordered to MATCH the model's
    output order (NOT Nori's alphabetical sort). Nori is bimanual with keys like
    'left_arm_shoulder_pan.pos'; a single-arm VLA commands one arm and the daemon
    holds the other. `arm` is "left" or "right"."""
    a = arm.strip().lower()
    if a not in ("left", "right"):
        raise ValueError(f"arm must be 'left' or 'right', got {arm!r}")
    return [f"{a}_arm_{j}.pos" for j in MOLMOACT2_JOINTS]


def infer_token() -> Optional[str]:
    """Bearer token for /act. File first (matches ~/.nori_infer_token written by
    the Space deploy), then env — so the token is never hardcoded or logged."""
    p = Path.home() / ".nori_infer_token"
    if p.is_file():
        tok = p.read_text().strip()
        if tok:
            return tok
    return os.environ.get("NORI_INFER_TOKEN")


def infer_url() -> Optional[str]:
    """Base URL of the cloud inference server. Swap this to move HF -> AWS/Modal."""
    url = os.environ.get("NORI_INFER_URL")
    return url.rstrip("/") if url else None


class CloudRollout:
    """Server-side chunk queue for one cloud rollout session.

    Thread model: the browser tick calls serve() (fast: buffer obs, pop one
    action, maybe kick a refill). Refills run on a short-lived daemon thread so
    the slow cloud call never blocks a tick. A single _inflight guard means at
    most one cloud request is outstanding at a time (no stale pile-up)."""

    def __init__(
        self,
        *,
        endpoint: str,
        token: str,
        instruction: str,
        action_keys: list[str],
        num_steps: int = DEFAULT_NUM_STEPS,
        watermark: int = REFILL_WATERMARK,
        max_queue: int = MAX_QUEUE,
        bounds: Optional[list[tuple[float, float]]] = None,
        caller: Optional[Callable[[list[str], list[float]], list[list[float]]]] = None,
    ):
        self.endpoint = endpoint.rstrip("/")
        self.token = token
        self.instruction = instruction
        # action_keys: the Nori joint keys, ordered to MATCH the model's output
        # order (built by arm_keys()). action[i] is named action_keys[i].
        self.action_keys = list(action_keys)
        self.action_dim = len(self.action_keys)
        if bounds is not None and len(bounds) != self.action_dim:
            raise ValueError("bounds length must equal action_keys length")
        self.bounds = bounds  # optional coarse clamp (daemon does the real clamp)
        self.num_steps = int(num_steps)
        self.watermark = int(watermark)
        self.max_queue = int(max_queue)
        self._call = caller or self._http_act  # injectable for tests

        self._queue: deque[list[float]] = deque()
        self._lock = threading.Lock()
        self._inflight = False
        self._pending_obs: Optional[tuple[list[str], list[float]]] = None
        self._error: Optional[str] = None
        # observability
        self.refills = 0
        self.chunks_received = 0
        self.actions_served = 0
        self.clamps = 0  # count of actions the bounds guard had to clip

    # -- the browser-tick entry point ------------------------------------
    def serve(self, images: list[str], state: list[float]) -> dict:
        """Buffer the latest observation, hand back the next queued action (or a
        warming marker if the buffer isn't primed yet), and kick an async refill
        when the buffer is low. Raises CloudRolloutError only when there is
        nothing to serve AND the last refill failed."""
        trigger = False
        with self._lock:
            self._pending_obs = (list(images), [float(s) for s in state])
            if len(self._queue) <= self.watermark and not self._inflight:
                self._inflight = True
                trigger = True
            action = self._queue.popleft() if self._queue else None
            qlen = len(self._queue)
            err = self._error if action is None else None
            if action is not None:
                self.actions_served += 1
        if trigger:
            threading.Thread(target=self._refill, name="cloud-refill", daemon=True).start()
        if action is not None:
            action = self._clamp(action)
            # Name-based map: action[i] is action_keys[i], which is built in the
            # model's canonical joint order (arm_keys) — so the RIGHT joint gets
            # the RIGHT value regardless of Nori's alphabetical telemetry sort.
            return {"action": dict(zip(self.action_keys, action)), "queue": qlen, "warming": False}
        if err:
            raise CloudRolloutError(err)
        return {"action": None, "queue": qlen, "warming": True}

    def _clamp(self, action: list[float]) -> list[float]:
        if not self.bounds:
            return action
        out = []
        clipped = False
        for v, (lo, hi) in zip(action, self.bounds):
            cv = lo if v < lo else (hi if v > hi else v)
            clipped = clipped or (cv != v)
            out.append(cv)
        if clipped:
            with self._lock:
                self.clamps += 1
            logger.warning("[CLOUD-ROLLOUT] clamped out-of-range action to model bounds")
        return out

    # -- refill (runs off-thread) ----------------------------------------
    def _refill(self) -> None:
        try:
            with self._lock:
                obs = self._pending_obs
            if obs is None:
                return
            images, state = obs
            chunk = self._call(images, state)
            clean: list[list[float]] = []
            for a in chunk:
                if len(a) != self.action_dim:
                    raise ValueError(
                        f"cloud action is {len(a)}-dim but the mapping expects "
                        f"{self.action_dim} ({self.action_keys}) — wrong robot/policy pairing."
                    )
                clean.append([float(x) for x in a])
            with self._lock:
                for a in clean:
                    if len(self._queue) >= self.max_queue:
                        break
                    self._queue.append(a)
                self.refills += 1
                self.chunks_received += 1
                self._error = None
            logger.info(
                "[CLOUD-ROLLOUT] refill +%d actions (queue=%d, refills=%d)",
                len(clean), len(self._queue), self.refills,
            )
        except Exception as e:  # keep the loop alive; surface via serve()/status
            logger.warning("[CLOUD-ROLLOUT] refill failed: %s", e)
            with self._lock:
                self._error = f"{type(e).__name__}: {e}"
        finally:
            with self._lock:
                self._inflight = False

    # -- the actual HTTP call to our cloud server ------------------------
    def _http_act(self, images: list[str], state: list[float]) -> list[list[float]]:
        payload = json.dumps({
            "images": images,
            "state": state,
            "instruction": self.instruction,
            "num_steps": self.num_steps,
        }).encode()
        req = urllib.request.Request(
            f"{self.endpoint}/act",
            data=payload,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.token}",
            },
        )
        with urllib.request.urlopen(req, timeout=ACT_TIMEOUT) as r:
            data = json.load(r)
        actions = data.get("actions")
        if not isinstance(actions, list) or not actions:
            raise ValueError("cloud /act returned no actions")
        return actions

    def status(self) -> dict:
        with self._lock:
            return {
                "queue": len(self._queue),
                "inflight": self._inflight,
                "error": self._error,
                "refills": self.refills,
                "chunks_received": self.chunks_received,
                "actions_served": self.actions_served,
                "clamps": self.clamps,
            }


def health_check(endpoint: str, timeout: float = HEALTH_TIMEOUT) -> dict:
    """GET /health (no auth). Wakes a sleeping Space and reports load status."""
    with urllib.request.urlopen(f"{endpoint.rstrip('/')}/health", timeout=timeout) as r:
        return json.load(r)
