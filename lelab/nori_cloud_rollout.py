# NORI: Additive file. Phase 2 of the cloud-inference spike (task #38).
#
# Chunk-queue client for a CLOUD VLA endpoint (MolmoAct2-SO100_101 served by our
# own FastAPI server — see cloud_inference/molmoact2_server.py — on a HF Docker
# Space today, an AWS g5 / Modal box tomorrow). This is the laptop-side "client"
# to that endpoint; it is HOST-AGNOSTIC — it only speaks the /act HTTP contract,
# so moving the server HF -> AWS changes one env var (NORI_INFER_URL), nothing here.
#
# WHY A QUEUE. A VLA returns a whole action CHUNK (~30 moves) per call and the
# call is slow (~0.30s on-GPU, but ~0.7-1.2s round-trip from the robot's network,
# ~3.6s on the first CUDA-graph compile) — far too slow to run every control tick.
# So we run it OPEN-LOOP: buffer the chunk and hand the browser one action per tick;
# when the buffer falls to `watermark`, fire ONE async refill so the next chunk
# lands before the buffer drains.
#
# TWO field-tuned behaviours (a laptop run stuttered + moved indecisively):
#  - watermark MUST cover the refill round-trip or the queue empties and the robot
#    gets no command (the stutter). Default 15 @15fps ≈ 1s of lead; bump via
#    NORI_INFER_WATERMARK if `starvations` in status() stays > 0.
#  - replace_on_refill (receding horizon): a fresh chunk REPLACES the stale
#    remainder rather than queueing behind it, so we never execute a 2s-old tail
#    (the "drives toward a stale target" indecision). Bounds staleness to ~the
#    refill latency. There is a hard floor here — at high latency you trade
#    staleness for starvation; the real fix is lower latency (in-region GPU /
#    fewer num_steps) or a finetune, not queue tuning.
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

# Trigger a refill when the buffer falls to this many actions. It MUST cover the
# refill round-trip (browser->lelab->cloud->back), or the queue empties and the
# robot gets no command → the stutter/jitter seen in the field. From the robot's
# network the round-trip is ~0.7-1.2s, so at 15fps we need ~12-18 actions of lead.
REFILL_WATERMARK = 15
# Bound the buffer so we never execute a stale backlog. An action that sits N deep
# is served ~N/fps seconds after its source observation — open-loop staleness. 24
# @15fps ≈ 1.6s worst case; combined with replace-on-refill the effective staleness
# is the refill latency, not the full chunk.
MAX_QUEUE = 24
DEFAULT_NUM_STEPS = 10
HEALTH_TIMEOUT = 8.0
ACT_TIMEOUT = 20.0  # first call compiles a CUDA graph (~3.6s); leave slack


def _env_int(name: str, default: int) -> int:
    try:
        v = int(os.environ.get(name, ""))
        return v if v > 0 else default
    except (ValueError, TypeError):
        return default


def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    return default if v is None else v.strip().lower() in ("1", "true", "yes", "on")


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


# MolmoAct2 was trained on TWO external workspace views (a "top" and a "side"
# RealSense) and is camera-ORDER-invariant ("random camera order is acceptable").
# Nori's external/scene tiles are "overhead" and "front"; the "left_wrist" /
# "right_wrist" tiles are egocentric/onboard — the wrong domain for this
# checkpoint. So default to the two scene tiles (order doesn't matter). A session
# without these tiles (single-composite) fails loudly at the client, listing the
# tiles it does have — set `views` explicitly or NORI_INFER_VIEWS to override.
DEFAULT_CLOUD_VIEWS = ["observation.images.overhead", "observation.images.front"]


def load_calibration(arm: str) -> Optional[dict]:
    """Optional per-joint affine that reconciles Nori's joint convention with the
    SO-100/101 convention MolmoAct2 was trained on. Applied FORWARD to the state
    (state_model = A*state_nori + B) and INVERSE to the action (action_nori =
    (action_model - B)/A). Derived by cloud_inference/derive_calibration.py from a
    reference capture + the model's norm_stats — a live check showed it cuts the
    open-loop error ~10x (20.9deg -> 2.1deg), so the embodiment gap is mostly a
    linear convention difference, not a deep domain gap.

    Source: NORI_INFER_CALIB (a JSON path) or ~/.nori_joint_calib.json. JSON is
    either {"A":[6],"B":[6]} (model joint order) or {"left":{...},"right":{...}}.
    Returns {"A","B"} for `arm`, or None (calibration disabled — raw pass-through)."""
    path = os.environ.get("NORI_INFER_CALIB")
    p = Path(path) if path else (Path.home() / ".nori_joint_calib.json")
    if not p.is_file():
        return None
    try:
        d = json.loads(p.read_text())
        cal = d.get(arm, d)
        A = [float(x) for x in cal["A"]]
        B = [float(x) for x in cal["B"]]
    except Exception as e:
        logger.warning("[CLOUD-ROLLOUT] unreadable calibration %s (%s)", p, e)
        return None
    if len(A) != 6 or len(B) != 6 or any(abs(a) < 1e-6 for a in A):
        logger.warning("[CLOUD-ROLLOUT] calibration A/B must be length 6 with non-zero A")
        return None
    return {"A": A, "B": B}


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
        replace_on_refill: bool = True,
        bounds: Optional[list[tuple[float, float]]] = None,
        calib: Optional[dict] = None,
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
        # calib {"A","B"}: per-joint affine reconciling Nori<->SO-100/101 convention
        # (forward on state, inverse on action). None = raw pass-through.
        if calib is not None and (len(calib["A"]) != self.action_dim or len(calib["B"]) != self.action_dim):
            raise ValueError("calib A/B length must equal action_keys length")
        self.calib = calib
        self.num_steps = int(num_steps)
        self.watermark = int(watermark)
        self.max_queue = max(int(max_queue), self.watermark + 1)
        # replace_on_refill: on refill, DROP the stale remainder and jump to the
        # fresh chunk (receding horizon) instead of appending behind it. Bounds the
        # worst-case open-loop staleness to the refill latency rather than a whole
        # 30-step chunk (~2s) — the "indecisive, moves toward a stale target" jitter.
        self.replace_on_refill = bool(replace_on_refill)
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
        self.starvations = 0  # ticks the buffer was empty AFTER priming (the stutter)

    # -- the browser-tick entry point ------------------------------------
    def serve(self, images: list[str], state: list[float]) -> dict:
        """Buffer the latest observation, hand back the next queued action (or a
        warming marker if the buffer isn't primed yet), and kick an async refill
        when the buffer is low. Raises CloudRolloutError only when there is
        nothing to serve AND the last refill failed."""
        trigger = False
        # Forward-calibrate the raw Nori state into the model's convention BEFORE
        # it's sent (state_model = A*state_nori + B); the queued actions come back
        # in model space and are inverse-calibrated on the way out.
        with self._lock:
            self._pending_obs = (list(images), self._cal_forward([float(s) for s in state]))
            if len(self._queue) <= self.watermark and not self._inflight:
                self._inflight = True
                trigger = True
            action = self._queue.popleft() if self._queue else None
            qlen = len(self._queue)
            err = self._error if action is None else None
            if action is not None:
                self.actions_served += 1
            elif self.actions_served > 0 and not err:
                self.starvations += 1  # primed but empty this tick = a stutter gap
        if trigger:
            threading.Thread(target=self._refill, name="cloud-refill", daemon=True).start()
        if action is not None:
            action = self._clamp(action)          # model-space bounds (guard) first
            action = self._cal_inverse(action)    # then model -> Nori convention
            # Name-based map: action[i] is action_keys[i], which is built in the
            # model's canonical joint order (arm_keys) — so the RIGHT joint gets
            # the RIGHT value regardless of Nori's alphabetical telemetry sort.
            return {"action": dict(zip(self.action_keys, action)), "queue": qlen, "warming": False}
        if err:
            raise CloudRolloutError(err)
        return {"action": None, "queue": qlen, "warming": True}

    def _cal_forward(self, state: list[float]) -> list[float]:
        """Nori state -> model convention (A*s + B)."""
        if not self.calib:
            return state
        return [a * s + b for s, a, b in zip(state, self.calib["A"], self.calib["B"])]

    def _cal_inverse(self, action: list[float]) -> list[float]:
        """Model action -> Nori convention ((a - B)/A)."""
        if not self.calib:
            return action
        return [(v - b) / a for v, a, b in zip(action, self.calib["A"], self.calib["B"])]

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
            fresh = clean[: self.max_queue]  # receding horizon: never buffer a long stale tail
            with self._lock:
                if self.replace_on_refill:
                    # Drop whatever stale actions remain and switch to the fresh plan.
                    self._queue.clear()
                    self._queue.extend(fresh)
                else:
                    for a in fresh:
                        if len(self._queue) >= self.max_queue:
                            break
                        self._queue.append(a)
                self.refills += 1
                self.chunks_received += 1
                self._error = None
            logger.info(
                "[CLOUD-ROLLOUT] refill %s%d actions (queue=%d, refills=%d)",
                "=" if self.replace_on_refill else "+", len(fresh), len(self._queue), self.refills,
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
                "starvations": self.starvations,
                "watermark": self.watermark,
                "max_queue": self.max_queue,
                "replace_on_refill": self.replace_on_refill,
            }


def health_check(endpoint: str, timeout: float = HEALTH_TIMEOUT) -> dict:
    """GET /health (no auth). Wakes a sleeping Space and reports load status."""
    with urllib.request.urlopen(f"{endpoint.rstrip('/')}/health", timeout=timeout) as r:
        return json.load(r)
