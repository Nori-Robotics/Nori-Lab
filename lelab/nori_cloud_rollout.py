# NORI: Additive file. Phase 2 of the cloud-inference spike (task #38).
#
# Chunk-queue client for a CLOUD VLA endpoint (MolmoAct2-SO100_101 served by our
# own FastAPI server — see cloud_inference/molmoact2_server.py — on a HF Docker
# Space today, an AWS g5 / Modal box tomorrow). This is the laptop-side "client"
# to that endpoint; it is HOST-AGNOSTIC — it only speaks the /act HTTP contract,
# so moving the server HF -> AWS changes one env var (NORI_INFER_URL), nothing here.
#
# WHY A QUEUE. A VLA returns a whole action CHUNK (~30 moves) per call and the
# call is slow (~0.30s on-GPU, ~0.39s round-trip on a pooled connection,
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
#    staleness for starvation.
#
# MEASURED 2026-07-20, and it overturned the assumption above. The round trip was
# NOT dominated by distance -- it was dominated by us opening a fresh TCP+TLS
# connection per /act. With real 29KB frames against the HF Space:
#   fresh conn per call : rtt 731ms | compute 303ms | network 428ms
#   reused connection   : rtt 392ms | compute 303ms | network  89ms
# 340ms/request (46%) was self-inflicted; only 89ms is actual distance. So "the
# real fix is an in-region GPU" was wrong -- the fix was a connection pool, and
# a closer GPU would now save ~60ms more, not ~700ms.
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
import time
import uuid
import urllib.error
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
# The rate the model's chunk was AUTHORED at. MolmoAct2's rule is "one training
# sequence = one second of robot motion, so the number of actions in a chunk is
# set by the control frequency of the source dataset" -- SO-100/101 was 30Hz,
# hence a 30-action chunk. Serving ONE action per control tick therefore replays
# that second at OUR tick rate: at 15fps a 1s motion is stretched over 2s, at
# 10fps over 3s. That is the "moves very slowly" report, and it is arithmetic,
# not a model failure. We advance `stride = chunk_hz / fps` actions per tick.
MOLMOACT2_CHUNK_HZ = 30.0
HEALTH_TIMEOUT = 8.0
ACT_TIMEOUT = 20.0  # first call compiles a CUDA graph (~3.6s); leave slack
CONNECT_TIMEOUT = 10.0
# Keep the pooled connection alive between refills, but expire it well before any
# load balancer would: reusing a socket the far end has already half-closed
# surfaces as a sporadic 502. Refills run ~1/s (continuous) to ~1/1.75s
# (stop-and-stare), so 30s keeps the connection hot with a wide safety margin.
KEEPALIVE_EXPIRY_S = 30.0


def _env_int(name: str, default: int) -> int:
    try:
        v = int(os.environ.get(name, ""))
        return v if v > 0 else default
    except (ValueError, TypeError):
        return default


def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    return default if v is None else v.strip().lower() in ("1", "true", "yes", "on")


class CloudEndpointWaking(RuntimeError):
    """The endpoint is up but not serving yet (HF Space cold start: the container
    answers while the 21GB model loads, ~3-4 min). TRANSIENT — the rollout should
    wait, not die. Kept distinct from CloudRolloutError because the browser's
    watchdog stops after 5 consecutive failures (~0.3s at 15fps), so treating a
    wake as a hard error guaranteed that any sleep killed the run outright."""


# How long to tolerate a waking endpoint before calling it a real failure. A cold
# start with a 21GB model measured ~3.5 min warm and ~6.5 min from a deep sleep,
# so allow a margin beyond that.
WARMING_GRACE_S = 480.0


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


# TWO views, and one of them is the WRIST of the arm being driven.
#
# This corrects an earlier comment here which asserted the wrist tiles were "the
# wrong domain for this checkpoint" and defaulted to two scene tiles. That was
# wrong on both counts:
#   - The paper's own SO-100 evaluation (§6.2) used "the wrist camera and a
#     third-person external camera" — not two external views.
#   - Camera COUNT is the part that is off-distribution if you get it wrong: of
#     the 1,222 datasets in the SO-100/101 training mix, 835 had exactly 2
#     cameras and only 6 had four (paper Table 23).
#   - Grasp state specifically is judged from the wrist view: the dataset's own
#     annotation prompt says to "only say the arm is grasping an object if this
#     is shown in the wrist camera when the gripper is closed". A policy asked to
#     decide when to close the gripper, given no wrist view, is being asked for a
#     judgement its training grounded in a camera we never sent.
#
# Camera ORDER remains irrelevant for this checkpoint ("random camera order is
# acceptable") — it was trained on heterogeneous community rigs. Only the count
# and the kind matter. The wrist tile must follow the driven arm, so the default
# is built per-session from `arm`; DEFAULT_CLOUD_VIEWS is the fallback for the
# left arm. Override with `views` or NORI_INFER_VIEWS.
def default_cloud_views(arm: str = "left") -> list[str]:
    a = arm.strip().lower() if arm else "left"
    if a not in ("left", "right"):
        a = "left"
    return [f"observation.images.{a}_wrist", "observation.images.overhead"]


DEFAULT_CLOUD_VIEWS = default_cloud_views("left")


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
        # No hand-derived file: fall back to the EXACT affine computed from the
        # robot's own calibration, delivered by the policy-stream preamble and
        # persisted by policy_stream_rx (never goes stale across motor recals).
        # A capture-derived file, when present, still wins — it can carry the
        # measured asymmetric gains the exact mapping doesn't model.
        from .nori_units import load_streamed_calibration
        cal = load_streamed_calibration(arm)
        if cal is None:
            logger.warning("[CLOUD-ROLLOUT] NO units calibration (no %s, no streamed "
                           "robot.json) — state/actions pass through RAW; expect a "
                           "wrong first pose. Start a policy stream or run "
                           "cloud_inference/derive_calibration.py.", p)
        return cal
    try:
        d = json.loads(p.read_text())
        cal = d.get(arm, d)
        A = [float(x) for x in cal["A"]]
        B = [float(x) for x in cal["B"]]
        # OPTIONAL asymmetric gains. The two directions can genuinely want different
        # scales on a joint the reference capture barely exercised (measured on
        # wrist_roll, 3.7deg of span in move_red_left):
        #   forward  wants A~1 -- a large A multiplies sensor NOISE into the model's
        #            input, so a near-static joint reads as thrashing and every
        #            prediction destabilises.
        #   inverse  wants a large A -- undamped, the model's full +-50deg of roll
        #            passes straight through, the rolled state feeds back, and the
        #            joint walks monotonically into its mechanical stop (observed:
        #            0 -> -50deg -> "blocked (stall:left_arm_wrist_roll)", which then
        #            stalled shoulder_lift too).
        # One gain cannot serve both. Absent these keys, behaviour is unchanged.
        A_inv = [float(x) for x in cal.get("A_inverse", A)]
        B_inv = [float(x) for x in cal.get("B_inverse", B)]
    except Exception as e:
        logger.warning("[CLOUD-ROLLOUT] unreadable calibration %s (%s)", p, e)
        return None
    for name, vals in (("A", A), ("B", B), ("A_inverse", A_inv), ("B_inverse", B_inv)):
        if len(vals) != 6:
            logger.warning("[CLOUD-ROLLOUT] calibration %s must be length 6", name)
            return None
    if any(abs(a) < 1e-6 for a in A) or any(abs(a) < 1e-6 for a in A_inv):
        logger.warning("[CLOUD-ROLLOUT] calibration gains must be non-zero")
        return None
    if A_inv != A or B_inv != B:
        logger.info("[CLOUD-ROLLOUT] asymmetric calibration: forward A=%s / inverse A=%s", A, A_inv)
    return {"A": A, "B": B, "A_inverse": A_inv, "B_inverse": B_inv}


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
        # None = "auto": use the default and let the stride block resize it. An
        # explicit value is HONOURED as-is, which is what makes stop-and-stare
        # (watermark=1 -> refill only when the plan is spent, from a FRESH
        # observation) expressible. Without this the stride sizing silently
        # overrode the caller.
        watermark: Optional[int] = None,
        max_queue: int = MAX_QUEUE,
        replace_on_refill: bool = True,
        fps: float = 0.0,
        chunk_hz: float = MOLMOACT2_CHUNK_HZ,
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
        watermark_auto = watermark is None
        self.watermark = REFILL_WATERMARK if watermark_auto else int(watermark)
        self.max_queue = max(int(max_queue), self.watermark + 1)
        # replace_on_refill: on refill, DROP the stale remainder and jump to the
        # fresh chunk (receding horizon) instead of appending behind it. Bounds the
        # worst-case open-loop staleness to the refill latency rather than a whole
        # 30-step chunk (~2s) — the "indecisive, moves toward a stale target" jitter.
        self.replace_on_refill = bool(replace_on_refill)
        # Play the chunk at the rate it was AUTHORED (see MOLMOACT2_CHUNK_HZ):
        # advance chunk_hz/fps actions per tick, serving the one we land on. At
        # 30fps stride is 1 and nothing changes; at 15fps it is 2, restoring the
        # model's intended speed.
        #
        # COST, stated plainly: stride N drains the buffer N times faster, so the
        # queue holds ~1 SECOND of motion regardless of fps, while a refill
        # round-trip is 0.7-1.2s. Correct-speed playback therefore runs at the edge
        # of starvation and no queue tuning fixes it -- a 1s chunk cannot cover a
        # >1s round-trip. Watch status()["starvations"]; if it climbs the answer is
        # lower latency (in-region GPU) or RTC, not a bigger buffer.
        # NORI_INFER_STRIDE=1 restores the old slow-but-smooth behaviour.
        self.fps = float(fps) if fps and fps > 0 else 0.0
        self.chunk_hz = float(chunk_hz) if chunk_hz and chunk_hz > 0 else 0.0
        self.stride = (max(1, int(round(self.chunk_hz / self.fps)))
                       if self.fps > 0 and self.chunk_hz > 0 else 1)
        if self.stride > 1:
            # At stride N the buffer is measured in TIME, not actions, and a chunk
            # is only ~1s long. Truncating it (the old MAX_QUEUE=24, chosen when one
            # action == one tick) discards cover we cannot spare, so hold the whole
            # chunk and refill as early as the single-in-flight rule allows.
            self.max_queue = max(self.max_queue, int(round(self.chunk_hz)))
            if watermark_auto:
                self.watermark = max(self.watermark, self.max_queue - 3)
            self.max_queue = max(self.max_queue, self.watermark + 1)
        self._call = caller or self._http_act  # injectable for tests

        self._queue: deque[list[float]] = deque()
        self._lock = threading.Lock()
        self._inflight = False
        self._pending_obs: Optional[tuple[list[str], list[float]]] = None
        self._error: Optional[str] = None
        self._warming_since: Optional[float] = None
        self._http = None  # lazily-built, REUSED httpx.Client (see _client)
        # RTC. Opt-in (NORI_INFER_RTC=1) because it costs ~+524ms of server compute:
        # it needs autograd and the CUDA-graph path off. Viable only now that the
        # pooled connection cut the round trip to ~386ms (827+89 = 916ms < the 1s a
        # chunk covers); at the old 731ms it did not fit.
        self.rtc_enabled = _env_bool("NORI_INFER_RTC", False)
        self._rtc_session = uuid.uuid4().hex[:16]
        self._rtc_pending: Optional[dict] = None   # set per-refill, read by _http_act
        self._chunk_len = 0        # length of the chunk currently draining
        self._rtt_s = 0.0          # EWMA of measured refill round-trip
        self.rtc_last: Optional[dict] = None       # server's report, for status()
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
            # Advance `stride` steps through the plan and serve the one we land on,
            # so a chunk authored at chunk_hz plays out in its intended wall-clock
            # duration instead of being stretched by (chunk_hz/fps).
            action = None
            for _ in range(self.stride):
                if not self._queue:
                    break
                action = self._queue.popleft()
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
        with self._lock:
            waking = self._warming_since
        if waking is not None and (time.monotonic() - waking) > WARMING_GRACE_S:
            raise CloudRolloutError(
                f"endpoint still not serving after {WARMING_GRACE_S:.0f}s — treating as down")
        return {"action": None, "queue": qlen, "warming": True}

    def _cal_forward(self, state: list[float]) -> list[float]:
        """Nori state -> model convention (A*s + B)."""
        if not self.calib:
            return state
        return [a * s + b for s, a, b in zip(state, self.calib["A"], self.calib["B"])]

    def _cal_inverse(self, action: list[float]) -> list[float]:
        """Model action -> Nori convention ((a - B)/A).

        Uses the INVERSE gains, which default to the forward ones (so a plain
        {"A","B"} calibration behaves exactly as before). See load_calibration for
        why a joint can need a different scale in each direction."""
        if not self.calib:
            return action
        A = self.calib.get("A_inverse", self.calib["A"])
        B = self.calib.get("B_inverse", self.calib["B"])
        return [(v - b) / a for v, a, b in zip(action, A, B)]

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
            # RTC needs two counts, both in CHUNK-action units (the chunk plays at
            # chunk_hz regardless of our tick rate):
            #   consumed — how much of the previous chunk already executed, which
            #              aligns the cached chunk to the new timeline
            #   delay    — how much WILL execute while this inference runs, which
            #              becomes the frozen prefix. Estimated from measured RTT,
            #              so it self-corrects as the network moves.
            if self.rtc_enabled:
                with self._lock:
                    remaining = len(self._queue)
                consumed = max(0, self._chunk_len - remaining)
                hz = self.chunk_hz or MOLMOACT2_CHUNK_HZ
                delay = int(round((self._rtt_s or 0.4) * hz))
                self._rtc_pending = {"session": self._rtc_session,
                                     "consumed": consumed, "delay": delay}
            _t0 = time.monotonic()
            chunk = self._call(images, state)
            rtt = time.monotonic() - _t0
            # EWMA: one slow call shouldn't swing the frozen-prefix length.
            self._rtt_s = rtt if self._rtt_s <= 0 else (0.7 * self._rtt_s + 0.3 * rtt)
            self._chunk_len = len(chunk)
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
                if self._warming_since is not None:
                    logger.info("[CLOUD-ROLLOUT] endpoint back — resuming after %.0fs",
                                time.monotonic() - self._warming_since)
                    self._warming_since = None
                self._error = None
            logger.info(
                "[CLOUD-ROLLOUT] refill %s%d actions (queue=%d, refills=%d)",
                "=" if self.replace_on_refill else "+", len(fresh), len(self._queue), self.refills,
            )
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            # Classify at the REFILL boundary, not only inside _http_act: a 503 or a
            # read timeout means "cold start" no matter which layer raised it (an
            # injected caller, a proxy, a future transport).
            code = getattr(e, "code", None)
            if code is not None and code != 503:
                logger.warning("[CLOUD-ROLLOUT] refill failed: %s", e)
                with self._lock:
                    self._error = f"{type(e).__name__}: {e}"
                    self._warming_since = None
            else:
                with self._lock:
                    if self._warming_since is None:
                        self._warming_since = time.monotonic()
                        logger.info("[CLOUD-ROLLOUT] endpoint waking (%s) — holding the "
                                    "rollout while it loads (up to %.0fs)", e, WARMING_GRACE_S)
                    self._error = None
        except CloudEndpointWaking as e:
            # Transient: hold the rollout in "warming" instead of failing it.
            with self._lock:
                if self._warming_since is None:
                    self._warming_since = time.monotonic()
                    logger.info("[CLOUD-ROLLOUT] %s — holding the rollout while it loads "
                                "(up to %.0fs)", e, WARMING_GRACE_S)
                self._error = None
        except Exception as e:  # keep the loop alive; surface via serve()/status
            logger.warning("[CLOUD-ROLLOUT] refill failed: %s", e)
            with self._lock:
                self._error = f"{type(e).__name__}: {e}"
                self._warming_since = None
        finally:
            with self._lock:
                self._inflight = False

    # -- the actual HTTP call to our cloud server ------------------------
    def _client(self):
        """One REUSED connection for the whole rollout, built on first use.

        We previously opened a fresh urllib connection per /act, paying a full
        TCP+TLS handshake every inference. Measured against the HF Space with
        real 29KB frames:

            fresh conn per call : rtt 731ms | compute 303ms | network 428ms
            reused connection   : rtt 392ms | compute 303ms | network  89ms

        340ms/request, 46% of the round-trip, for nothing. The residual 89ms is
        the actual distance to the GPU; the rest was self-inflicted. This also
        decides other things: RTC costs +524ms of compute, which does NOT fit a
        1s chunk at 731ms but DOES at 392ms.

        Built lazily so constructing a CloudRollout (e.g. in tests, with an
        injected caller) opens no sockets."""
        if self._http is None:
            import httpx

            self._http = httpx.Client(
                timeout=httpx.Timeout(ACT_TIMEOUT, connect=CONNECT_TIMEOUT),
                limits=httpx.Limits(max_connections=4, max_keepalive_connections=4,
                                    keepalive_expiry=KEEPALIVE_EXPIRY_S),
                headers={"Content-Type": "application/json",
                         "Authorization": f"Bearer {self.token}"},
            )
        return self._http

    def close(self) -> None:
        """Release the pooled connection. Safe to call twice."""
        if self._http is not None:
            try:
                self._http.close()
            except Exception:
                pass
            self._http = None

    def _http_act(self, images: list[str], state: list[float]) -> list[list[float]]:
        import httpx

        payload = {
            "images": images,
            "state": state,
            "instruction": self.instruction,
            "num_steps": self.num_steps,
        }
        if self.rtc_enabled and self._rtc_pending:
            payload["rtc"] = self._rtc_pending
        try:
            r = self._client().post(f"{self.endpoint}/act", json=payload)
        except httpx.TimeoutException as e:
            # A sleeping Space accepts the TCP connection then never answers.
            raise CloudEndpointWaking(f"endpoint slow/unreachable ({type(e).__name__})") from e
        except httpx.TransportError as e:
            # Connect/read/protocol errors — incl. a pooled socket the far end
            # closed. Transient by nature; the next refill rebuilds the pool.
            self.close()
            raise CloudEndpointWaking(f"transport error ({type(e).__name__})") from e
        if r.status_code == 503:
            # our server's "model not loaded yet", or the Space proxy's own
            # unavailable — a cold start, not a broken deployment.
            raise CloudEndpointWaking("endpoint waking (HTTP 503)")
        r.raise_for_status()  # 401/404/500 stay HARD errors and fail fast
        data = r.json()
        self.rtc_last = data.get("rtc")
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
                # stride > 1 means we are playing the chunk at its authored rate;
                # buffer_seconds is the wall-clock motion the queue holds, which is
                # what must cover the refill round-trip (not the action count).
                "rtc_enabled": self.rtc_enabled,
                "rtc": self.rtc_last,
                "rtt_ms": round(self._rtt_s * 1000) if self._rtt_s else None,
                "stride": self.stride,
                "fps": self.fps,
                "buffer_seconds": (len(self._queue) / self.chunk_hz) if self.chunk_hz else None,
            }


def health_check(endpoint: str, timeout: float = HEALTH_TIMEOUT) -> dict:
    """GET /health (no auth). Wakes a sleeping Space and reports load status."""
    with urllib.request.urlopen(f"{endpoint.rstrip('/')}/health", timeout=timeout) as r:
        return json.load(r)
