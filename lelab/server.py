# Copyright 2025 The HuggingFace Inc. team. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import asyncio
import contextlib
import glob
import json
import logging
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.datastructures import Headers
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response
from starlette.types import Scope

from . import datasets as dataset_browser

# Import our custom calibration functionality
from .calibrate import CalibrationRequest, calibration_manager
from .jobs import (
    JobAlreadyRunningError,
    JobNotFoundError,
    JobNotRunningError,
    JobTarget,
    job_registry,
)
from .nori_client import ManifestError, NoriBackendError, NoriClient  # NORI: cloud API client
from .nori_leader_setup import (
    DEFAULT_CALIBRATION_ID as DEFAULT_LEADER_CALIBRATION_ID,
    auto_manager as nori_leader_auto_manager,
    auto_save_detected_ports,
    close_shared_live_reader,
    expected_joint_ids,
    identify_leader_motors,
    list_directions as list_nori_leader_directions,
    manual_manager as nori_leader_manual_manager,
    probe_leader_ports,
    read_live_targets,
    read_shared_live_positions,
    save_ports_from_paths,
    set_connected_servo_id,
    set_direction as set_nori_leader_direction,
)

# Import our custom recording functionality
from .record import (
    DatasetInfoRequest,
    RecordingRequest,
    UploadRequest,
    handle_delete_dataset,
    handle_exit_early,
    handle_get_dataset_info,
    handle_recording_status,
    handle_rerecord_episode,
    handle_start_recording,
    handle_stop_recording,
    handle_upload_dataset,
)
from .rollout import (
    InferenceRequest,
    handle_inference_status,
    handle_start_inference,
    handle_stop_inference,
)

# Import our custom teleoperation functionality
from .teleoperate import (
    TeleoperateRequest,
    handle_get_joint_positions,
    handle_start_teleoperation,
    handle_stop_teleoperation,
    handle_teleoperation_status,
)

# Training is now job-based; see app/jobs.py.
from .train import TrainingRequest
from .update import handle_run_update, handle_update_check
from .utils import config
from .utils.config import (
    FOLLOWER_CONFIG_PATH,
    LEADER_CONFIG_PATH,
    delete_robot_record,
    detect_port_after_disconnect,
    find_available_ports,
    find_robot_port,
    get_default_robot_port,
    get_robot_record,
    get_saved_robot_port,
    is_robot_record_clean,
    is_valid_robot_name,
    list_robot_records,
    save_robot_port,
    save_robot_record,
)
from .utils.hf_auth import cached_whoami, handle_hf_auth_status, handle_hf_login, shared_hf_api
from .utils.system import (
    handle_get_cuda_status,
    handle_get_training_extra,
    handle_get_wandb_extra,
    handle_install_training_extra,
    handle_install_training_extra_status,
    handle_install_wandb_extra,
    handle_install_wandb_extra_status,
    warn_if_cuda_mismatch,
)

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class StartTrainingBody(BaseModel):
    """Wrapping body for POST /jobs/training. Adds optional target spec."""

    config: TrainingRequest
    target: JobTarget | None = None

    @classmethod
    def from_legacy(cls, raw: dict) -> "StartTrainingBody":
        """Accept the old request shape (TrainingRequest fields at top level)
        as well as the new shape ({config: ..., target: ...}).
        """
        if "config" in raw and isinstance(raw["config"], dict):
            return cls.model_validate(raw)
        # Legacy: top-level training fields, no target.
        return cls(config=TrainingRequest.model_validate(raw))


# Cache for HF Jobs hardware flavors (5-minute TTL)
_flavors_cache: dict = {"data": None, "fetched_at": 0.0}
_FLAVOR_CACHE_TTL_SECONDS = 300.0


app = FastAPI()

# NORI: browser-catcher spool (remote-session dataset capture). Router-based —
# the module owns its /nori/capture/* surface; see lelab/browser_capture.py.
from .browser_capture import router as _capture_router  # noqa: E402

app.include_router(_capture_router)

# NORI: laptop-side policy execution for remote robots (/nori/rollout/*).
# Policies run HERE; only {type:"control", action} frames reach the robot —
# the Pi is a safety daemon, not a compute host (full_nori_plan §Robot push).
from .nori_rollout import router as _rollout_router  # noqa: E402

app.include_router(_rollout_router)

# NORI: local dataset episode review + curation (view/delete without HF).
from .dataset_episodes import router as _episodes_router  # noqa: E402

app.include_router(_episodes_router)

# In dev mode the React app runs on :8080 while the API runs on :8000; in
# prod they share an origin and CORS is unnecessary. allow_credentials with
# a wildcard origin is rejected by browsers, so we drop it.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"

# Get the path to the lerobot root directory (3 levels up from this script)
LEROBOT_PATH = str(Path(__file__).parent.parent.parent.parent)
logger.info(f"LeRobot path: {LEROBOT_PATH}")


class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []
        self.broadcast_queue = queue.Queue()
        self.broadcast_thread = None
        self.is_running = False
        # Guards `active_connections` since the broadcast worker thread also
        # mutates it on send failure.
        self._connections_lock = threading.Lock()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        with self._connections_lock:
            self.active_connections.append(websocket)
            count = len(self.active_connections)
        logger.info(f"WebSocket connected. Total connections: {count}")

        if not self.is_running:
            self.start_broadcast_thread()

    def disconnect(self, websocket: WebSocket):
        with self._connections_lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)
                count = len(self.active_connections)
                logger.info(f"WebSocket disconnected. Total connections: {count}")
            else:
                count = len(self.active_connections)

        if count == 0 and self.is_running:
            self.stop_broadcast_thread()

    def start_broadcast_thread(self):
        """Start the background thread for broadcasting data"""
        if self.is_running:
            return

        self.is_running = True
        self.broadcast_thread = threading.Thread(target=self._broadcast_worker, daemon=True)
        self.broadcast_thread.start()
        logger.info("📡 Broadcast thread started")

    def stop_broadcast_thread(self):
        """Stop the background thread"""
        self.is_running = False
        if self.broadcast_thread:
            self.broadcast_thread.join(timeout=1.0)
            logger.info("📡 Broadcast thread stopped")

    def _broadcast_worker(self):
        """Background worker thread for broadcasting WebSocket data"""
        import asyncio

        # Create a new event loop for this thread
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        try:
            while self.is_running:
                try:
                    # Get data from queue with timeout
                    data = self.broadcast_queue.get(timeout=0.1)
                    if data is None:  # Poison pill to stop
                        break

                    # Broadcast to all connections
                    if self.active_connections:
                        loop.run_until_complete(self._send_to_all_connections(data))

                except queue.Empty:
                    continue
                except Exception as e:
                    logger.error(f"Error in broadcast worker: {e}")

        finally:
            loop.close()

    async def _send_to_all_connections(self, data: dict[str, Any]):
        """Send data to all active WebSocket connections"""
        with self._connections_lock:
            connections = list(self.active_connections)
        if not connections:
            return

        disconnected = []
        for connection in connections:
            try:
                await connection.send_json(data)
            except Exception as e:
                logger.error(f"Error sending data to WebSocket: {e}")
                disconnected.append(connection)

        for connection in disconnected:
            self.disconnect(connection)

    def broadcast_joint_data_sync(self, data: dict[str, Any]):
        """Thread-safe method to queue data for broadcasting"""
        if self.is_running and self.active_connections:
            try:
                self.broadcast_queue.put_nowait(data)
            except queue.Full:
                logger.warning("Broadcast queue is full, dropping data")

    def notify_jobs_changed(self) -> None:
        """Push a 'jobs_changed' event to all WS clients so they refetch.

        Called from JobRegistry on submit / watchdog finalisation / delete.
        Skipped silently if no clients are connected — the frontend does an
        initial fetch on mount, so a missed broadcast is self-healing.
        """
        if self.is_running and self.active_connections:
            with contextlib.suppress(queue.Full):
                self.broadcast_queue.put_nowait({"type": "jobs_changed", "timestamp": time.time()})

    def notify_job_progress(self, snapshots: list[dict]) -> None:
        """Push a 'job_progress' event with per-running-job snapshots.

        Fired from the JobRegistry watchdog (~1Hz) while jobs are running so
        the dashboard's progress bar updates live without refetching /jobs
        (let alone /jobs/hub, which hits the HF API on every call).
        """
        if self.is_running and self.active_connections:
            with contextlib.suppress(queue.Full):
                self.broadcast_queue.put_nowait(
                    {"type": "job_progress", "jobs": snapshots, "timestamp": time.time()}
                )


manager = ConnectionManager()
job_registry.set_on_change(manager.notify_jobs_changed)
job_registry.set_on_progress(manager.notify_job_progress)


@app.get("/get-configs")
def get_configs():
    # Get all available calibration configs
    leader_configs = [os.path.basename(f) for f in glob.glob(os.path.join(LEADER_CONFIG_PATH, "*.json"))]
    follower_configs = [os.path.basename(f) for f in glob.glob(os.path.join(FOLLOWER_CONFIG_PATH, "*.json"))]

    return {"leader_configs": leader_configs, "follower_configs": follower_configs}


@app.post("/move-arm")
def teleoperate_arm(request: TeleoperateRequest):
    """Start teleoperation of the robot arm"""
    return handle_start_teleoperation(request, manager)


@app.post("/stop-teleoperation")
def stop_teleoperation():
    """Stop the current teleoperation session"""
    return handle_stop_teleoperation()


@app.get("/teleoperation-status")
def teleoperation_status():
    """Get the current teleoperation status"""
    return handle_teleoperation_status()


@app.get("/joint-positions")
def get_joint_positions():
    """Get current robot joint positions"""
    return handle_get_joint_positions()


@app.post("/start-inference")
def start_inference(request: InferenceRequest):
    result = handle_start_inference(request)
    if not result.get("success"):
        raise HTTPException(
            status_code=result.get("status_code", 500),
            detail=result.get("message", "Failed to start inference"),
        )
    return result


@app.post("/stop-inference")
def stop_inference():
    result = handle_stop_inference()
    if not result.get("success"):
        raise HTTPException(
            status_code=result.get("status_code", 500),
            detail=result.get("message", "Failed to stop inference"),
        )
    return result


@app.get("/inference-status")
def inference_status():
    return handle_inference_status()


@app.get("/health")
def health_check():
    """Simple health check endpoint to verify server is running"""
    return {"status": "ok", "message": "FastAPI server is running"}


# NORI: public config + JWT plumbing for the Nori laptop-app additions.
# The frontend bootstraps Supabase/Nori-Backend config from here (single source of env,
# read by Python) instead of a separate frontend .env. Only browser-safe values are
# exposed — never the HF token or the Supabase service-role key.
@app.get("/nori/config")
def nori_config():
    return config.nori_public_config()


# ---- LLM codegen for the Coding page ("Generate") ----------------------------
# LeLab assembles the prompt and forwards it to Nori-Backend's gated/metered LLM proxy
# (/agent/llm/messages) behind the customer JWT — the ANTHROPIC key lives ONLY on the
# backend, never on the laptop or in a shipped bundle (docs/llm_codegen_design.md,
# HANDOFF.md §5). `model` here is just an id string (NORI_LLM_MODEL, default claude-sonnet-5);
# the backend holds the key. Keep NORI_CODEGEN_SYSTEM in sync with
# frontend/src/nori/remote/ScriptDriver.ts — that file is the ground-truth robot API.
NORI_CODEGEN_SYSTEM = """You generate short JavaScript routines that drive a robot called Nori through an injected async `nori` API. Your ENTIRE output is the BODY of an async function: no imports, no function wrapper, no markdown fences, no prose. Only statements, using `await nori.*`.

THE ROBOT API — every motion is OPEN-LOOP TIMED. You give a duration in ms; the move runs for that long then stops. There is NO arrival/success feedback (a "done" only means the time elapsed).

  nori.reach(side, dofs, ms)   Task-space (cylindrical) jog via IK.
                                 side: "left" | "right".
                                 dofs: subset of { x, y, pitch, shoulder_pan, wrist_roll, gripper },
                                 each a rate in [-1,1]. x/y translate the end-effector in the arm
                                 plane; +x forward, +y left. Held ms, then zeroed.
  nori.joint(side, dofs, ms)   Per-motor jog (no IK).
                                 dofs: subset of { shoulder_pan, shoulder_lift, elbow_flex,
                                 wrist_flex, wrist_roll, gripper }, each a rate in [-1,1].
  nori.moveTo(side, targets, opts?)  ABSOLUTE joint move: go to a pose and HOLD it (not timed).
                                 targets: subset of { shoulder_pan, shoulder_lift, elbow_flex,
                                 wrist_flex, wrist_roll, gripper } -> target value, SAME normalized
                                 scale as the robot state you're given ([-100,100]; gripper [0,100]).
                                 opts.slew = units/sec (default 60). This is how you do "go to X":
                                 read the target/current from the state and command it directly.
                                 RETURNS a status string: "done" (arrived), "blocked" (stalled/
                                 latched), or "timeout". You can branch on it. It will NOT force
                                 through an obstruction — the push is bounded and it stops + reports
                                 blocked, so do NOT blindly retry a blocked move into the same spot.
                                 (Ramped safely; no timing guess.) Base can't be positioned this way.
                                 NOTE: shoulder_pan/wrist_roll/gripper hold reliably; shoulder_lift/
                                 elbow_flex/wrist_flex are IK-coupled and may snap back after the move
                                 — to orient the wrist/height prefer reach(x/y/pitch).
  nori.grip(side, "open"|"close")   Convenience gripper open/close.
  nori.base(vec, ms)           Mobile base. vec: { linear, angular } in [-1,1].
                                 +linear = forward, +angular = turn left.
  nori.lift(side, dir, ms)     Raise/lower that arm's vertical rail. dir in [-1,1], + = up.
  nori.wait(ms)                 Hold position (the 50 Hz keep-alive continues).
  nori.reset()                  Re-sync the IK task cursor to current joint positions. Call this
                                 before a nori.reach(...) that follows any nori.joint(...) move.
  nori.telemetry()             -> { loopHz, safety, tempC, state:{...}, currents:{...} } or null.
                                 PROPRIOCEPTIVE ONLY — joint positions + currents. NO camera/vision.
  nori.perceive()              -> latest world-state from the robot's object detector:
                                 { objects: [{ label, confidence, bbox?, xyz?, id? }, ...] } or null
                                 if no detector is feeding frames. Poll it in a loop to REACT to what
                                 the robot sees (track / wait for / yield to an object). ALWAYS handle
                                 null — many robots have no detector — and fall back to a
                                 blind/telemetry-only routine.
  nori.playAudio(url)          Stream an audio clip (blob/data/https) to the robot speaker;
                                 resolves when playback ends.
  nori.log(...args)            Print to the operator's run-output panel.
  nori.estop()                 Emergency latch (the on-screen button is the primary path).

PRIMITIVES (prebuilt, composed from the above — PREFER these when one fits):
  nori.home(side)              Move the arm to a neutral straight pose and hold.
  nori.stow(side)              Move the arm to a compact parked pose and hold.
  nori.gripSequence(side)      Open, pause, then close the gripper (a simple pick).
  nori.wave(side, times=3)     Wave the wrist.

UNITS: every rate is normalized to [-1,1]; the robot scales it to a safe per-tick step. ~0.3-0.5 is a gentle, visible move; 1.0 is the max the robot allows (and a half-speed session cap clamps it further). Durations are milliseconds; a single hold is capped at 60000 ms.

HARD RULES you MUST follow:
1. `await` every nori.* call so moves run in sequence.
2. NEVER mix task DOFs (x, y, pitch) and joint DOFs (shoulder_lift, elbow_flex, wrist_flex) in the same call — the presence of a joint DOF switches that whole call to per-motor mode.
3. After any nori.joint(...) or nori.moveTo(...) move, call nori.reset() before a nori.reach(...) (the IK cursor goes stale and reach() would otherwise jump). Prefer one family per routine. For "go to a specific pose/config", PREFER nori.moveTo — absolute and holding, no timing guess.
4. Your only sight is nori.perceive() (when a detector is running) and any photo in this request — otherwise you are BLIND: no world model, never assume where objects are. Prefer small, reversible moves and short durations. Do not drive the base more than briefly.
5. No imports, no fetch, no DOM — only the robot API and plain JS (loops, math, variables).
6. Output ONLY the function body — valid JavaScript that runs as-is. No ``` fences. If you explain
   ANYTHING (an assumption, what you see in a photo, a limitation), it MUST be inside a // comment.
   NEVER emit a bare sentence/prose line outside a comment — it is a syntax error that breaks the
   whole script. When unsure, write a `// note:` comment and still produce runnable code.

GROUNDING: you may be given the current robot state (joint positions, lift heights, base) as the
STARTING pose. Use it to plan relative moves and to judge direction + magnitude (e.g. "shoulder_pan
is at +30, so jog it negative to center"). It is proprioceptive only.

VISION: you may be given a single still photo — often a COMPOSITE of several camera tiles. Use it to
locate things and choose directions. If a "Camera layout" is given, trust it for which tile is which
camera/arm and act on the CORRECT side. IMPORTANT: a wrist camera is mounted ON its arm, so its image
left/right is EGOCENTRIC and is NOT the robot's left/right — judge the robot's left vs right from the OVERHEAD 
or FRONT scene tiles, not from a wrist tile. FRONT scene tile is generally most useful for navigation. If NO layout is
given, do not assume which tile is which — state your assumption in a // comment and prefer
reversible moves. It is one frame, not a live view and not depth — estimate coarsely, never assume
exact distances, objects tend to appear closer than they are.

SAFETY CONTEXT (for your judgement, not things you can bypass): a human supervises with live video and an E-STOP; the daemon clamps joint ranges, latches on stall/over-temp, and safe-stops if the control stream dies. You cannot make the robot unsafe through this API — but you SHOULD still be conservative: gentle rates, short holds, log what you're doing.

EXAMPLE — "wave the right arm":
for (let i = 0; i < 3; i++) {
  await nori.joint("right", { wrist_flex: 0.4 }, 500);
  await nori.joint("right", { wrist_flex: -0.4 }, 500);
}
nori.log("waved");

EXAMPLE — "nudge forward a little, then open the left gripper":
await nori.base({ linear: 0.4 }, 700);
await nori.grip("left", "open");
nori.log("done");

If a request needs vision, is unsafe, or is unclear, generate the safest partial routine you can and nori.log(...) a short note on what you could not do."""


class NoriLlmGenerateBody(BaseModel):
    prompt: str
    current_code: str | None = None  # lets the user say "make it slower" about existing code
    robot_state: dict | None = None  # 9a: current proprioceptive pose (<motor>.pos, lift mm, base)
    image_b64: str | None = None  # Part 3: JPEG (base64, no data: prefix) from the robot camera
    camera_layout: str | None = None  # operator's description of which tile = which view/arm
    perception_active: bool | None = None  # is nori.perceive() receiving frames right now?
    retry_note: str | None = None  # appended on a client-side auto-retry (e.g. after a syntax error)


def _strip_code_fences(s: str) -> str:
    """Models sometimes wrap output in ```js … ``` despite instructions; unwrap it."""
    s = s.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else s[3:]
        if s.endswith("```"):
            s = s[: s.rfind("```")]
    return s.strip()


def _llm_prepare(body: NoriLlmGenerateBody):
    """Shared setup for both the one-shot and streaming endpoints: build the model id + the user
    message (code + 9a pose + Part-3 image). Returns (model, content). The Anthropic call itself
    is done by Nori-Backend (the key lives there, not here) — see nori_llm_generate."""
    model = os.environ.get("NORI_LLM_MODEL", "claude-sonnet-5")
    parts = []
    if body.current_code:
        parts.append(f"Current code:\n```js\n{body.current_code}\n```")
    if body.robot_state:
        # 9a: ground the model in the current pose so "go to / raise / center" plan from reality.
        parts.append(
            "Current robot state (proprioceptive, normalized: arm joints ~[-100,100], "
            "grippers [0,100], lifts in mm, base as velocities). Treat it as the STARTING pose "
            f"and plan moves relative to it:\n{json.dumps(body.robot_state)}"
        )
    if body.image_b64:
        # Tell the model a photo is attached, and (if the operator set it) which tile is which
        # view/arm — otherwise vision moves the wrong thing on a composite feed.
        layout = f"\nCamera layout (which tile is which): {body.camera_layout}" if body.camera_layout else ""
        parts.append("A still photo from the robot's camera is attached (one frame, not depth)." + layout)
    if body.perception_active is not None:
        # Tell the model whether perceive() will actually see data, so it only writes
        # perceive()-polling loops when a detector (or the dev mock) is really feeding frames.
        parts.append(
            "Perception: a detector IS feeding nori.perceive() frames right now — you may poll "
            "it to react to objects (still handle null defensively)."
            if body.perception_active
            else "Perception: nori.perceive() is NOT receiving frames right now and will return "
            "null — do NOT rely on it; write a blind/telemetry-only routine."
        )
    parts.append(f"Request: {body.prompt}")
    if body.retry_note:
        parts.append(f"IMPORTANT: {body.retry_note}")
    user = "\n\n".join(parts)
    # Part 3: an optional camera still gives the model spatial context ("go to the cup"). Send it as
    # an image block ahead of the text; without it the request is plain text as before.
    content: list = [{"type": "text", "text": user}]
    if body.image_b64:
        content.insert(0, {
            "type": "image",
            "source": {"type": "base64", "media_type": "image/jpeg", "data": body.image_b64},
        })
    return model, content


@app.post("/nori/llm/generate")
def nori_llm_generate(body: NoriLlmGenerateBody, request: Request):
    """One-shot codegen. Forwards the assembled prompt to Nori-Backend's gated/metered LLM
    proxy (the key lives there); each generation is its own run (`new_run=True`). Requires
    an authenticated request + a reachable backend — no local key path (fails closed)."""
    model, content = _llm_prepare(body)
    nori = _nori_client(request)
    result = _nori_proxy(
        lambda: nori.llm_messages(
            model=model,
            max_tokens=1500,
            system=NORI_CODEGEN_SYSTEM,
            messages=[{"role": "user", "content": content}],
            new_run=True,
        )
    )
    text = "".join(
        b.get("text", "") for b in result.get("content", []) if b.get("type") == "text"
    )
    return {"code": _strip_code_fences(text)}


@app.post("/nori/llm/generate/stream")
def nori_llm_generate_stream(body: NoriLlmGenerateBody, request: Request):
    """Same as /generate but streams the model's text as it's produced (text/plain chunks) so the
    editor fills live. The stream is piped straight from Nori-Backend's proxy, which charges the
    turn on completion. Pre-flight errors (429 hard-capped / 503 no key / auth) raise BEFORE the
    stream opens (an explicit budget gate here); a backend error mid-stream is emitted as a
    trailing JS comment (headers are already sent)."""
    model, content = _llm_prepare(body)
    nori = _nori_client(request)

    # Pre-flight budget gate so an out-of-budget customer gets a real 429 instead of a 200
    # stream — mirrors the /nori/llm/agent gate. The backend re-checks + charges regardless.
    budget = _nori_proxy(nori.get_agent_usage)
    if budget.get("hard_capped"):
        raise HTTPException(
            status_code=429,
            detail={
                "reason": "Daily agent token limit reached. It resets tomorrow (UTC).",
                "daily": _daily_view(budget),
            },
        )

    def gen():
        try:
            yield from nori.llm_messages_stream(
                model=model,
                max_tokens=1500,
                system=NORI_CODEGEN_SYSTEM,
                messages=[{"role": "user", "content": content}],
                new_run=True,
            )
        except NoriBackendError as exc:
            yield f"\n/* LLM error: {exc.detail} */"

    return StreamingResponse(gen(), media_type="text/plain; charset=utf-8")


# ---- Agentic vision loop (Tier-1.5) ------------------------------------------
# A closed-loop agent that accomplishes a goal by look -> act -> re-look, using Claude's vision on
# laptop-fetched frames (no on-Pi model). See docs/agentic_vision_loop.md. This endpoint is a THIN,
# STATELESS proxy: the browser owns the conversation (messages[]) + executes every tool on the robot;
# the server only injects the system prompt + tools and forwards each turn to Anthropic (key stays
# server-side). The tool SCHEMAS here are the contract the browser's dispatcher implements — keep them
# in sync with ScriptDriver.ts ops (moveTo/reach/joint/grip/base/lift/wait) and teleop.snapshot().
NORI_AGENT_SYSTEM = """You are an autonomous agent operating a robot called Nori to accomplish a goal the operator gives you. You work in a loop: LOOK at the world, decide, ACT with one or more tool calls, then LOOK again to verify — repeating until the goal is done or clearly impossible. A human supervises with live video and an E-STOP and must approve your first motion, so narrate your plan in plain text before you act.

HOW THE LOOP WORKS:
- Each of your turns may contain reasoning text plus tool calls. The operator's app executes your tool calls on the real robot and returns their results (an image for `look`, JSON/text otherwise) as the next message. Then you continue.
- START by calling `look` (and usually `get_state`) before any motion — you begin BLIND. After each motion, `look` again to check the effect; do not assume a move did what you intended.
- End the run by calling `done` (goal achieved) or `give_up` (unsafe or impossible). Do not keep acting after the goal is met.

ROBOT BODY LAYOUT (fixed geometry — memorize this; it does not change):
- The robot is a stationary-torso bimanual mobile robot. Picture it facing FORWARD (the direction it
  drives with a +linear base command). It has TWO arms mounted side by side on a central column/torso,
  plus a mobile base underneath.
- The "left" arm is on the robot's OWN LEFT; the "right" arm is on its OWN RIGHT — like your own two
  hands. This is the robot's egocentric frame (the same one the tool `side` uses). If you were standing
  IN FRONT of the robot looking at it, its left arm would appear on YOUR right (a mirror). Always reason
  in the ROBOT's frame, not a viewer's.
- Each arm hangs from its own vertical LIFT rail (raises/lowers that whole arm) and has, from the torso
  out: shoulder_pan (yaws the arm left/right), shoulder_lift, elbow_flex, wrist_flex, wrist_roll, gripper.
  At rest the upper arm is pitched up and the forearm reaches forward — the arms extend toward the FRONT.
- Cameras and how they see the body:
  * "front" tile: faces the same way the robot faces; it sees everything ahead, is most useful for navigation, and has the LEFT arm
    entering from the left of the frame and the RIGHT arm from the right (robot frame ≈ frame sides).
  * "overhead" tile: looks down onto the workspace in front of the robot from above — best for judging
    which side of the robot an object is on, how far ahead it is, and avoiding ground obstacles.
  * "<side>_wrist" tile: mounted ON that arm's wrist, so it moves WITH the arm and its image left/right
    is egocentric to the wrist, NOT the robot's — never infer the robot's left/right from a wrist tile.
  * Note that things often appear closer in the camera view than they really are. Overhead can be the best judge for direct distance.
- So: to decide WHICH ARM to use for an object, locate the object in the overhead/front scene tile, map
  it to the robot's left vs right using the rule above, and drive THAT arm. Use a wrist tile only for
  close-in framing of what the gripper is already near.

THE ROBOT / TOOLS:
  look       Capture a fresh still from ONE camera. Your only visual input — use it liberally, before
             and after acting. On a MULTI-CAMERA robot you MUST pass `look {camera: role}` (roles come
             from the "Camera layout" context — e.g. overhead, front, left_wrist, right_wrist); the
             combined all-tiles composite is NOT available to look at, because a single camera at full
             size is far clearer than a shrunken grid. Pick the camera for the job: an overhead/front
             SCENE camera to judge robot left/right and object locations, or a wrist camera for a
             close-up of that arm's workspace. On a single-camera robot, call `look` with no argument.
  get_state  Current joint positions + lift + base (proprioceptive, normalized: arm joints ~[-100,100],
             grippers [0,100]). No image.
  move_to    ABSOLUTE joint move on one arm: go to target positions and WAIT for arrival. Returns a real
             outcome: "done" (arrived), "blocked" (stalled/obstructed — do NOT blindly retry into the
             same spot), "clamped" (target was out of range), or "timeout". Same normalized scale as
             get_state. Best tool for "go to pose X". shoulder_pan/wrist_roll/gripper hold reliably;
             shoulder_lift/elbow_flex/wrist_flex are IK-coupled and may snap back — prefer `reach` for
             wrist orientation / height.
  reach      Task-space (cylindrical) jog held for `ms`, then stops. dofs subset of
             {x,y,pitch,shoulder_pan,wrist_roll,gripper}, each a rate in [-1,1]; +x forward, +y left.
             Open-loop and TIMED (no arrival feedback) — use short pulses and re-look.
  grip       Open or close the gripper on one arm.
  base       Drive the mobile base for `ms`: linear (+forward) and/or angular (+turn left), rates in
             [-1,1]. Open-loop, timed. Drive only briefly.
  lift       Raise/lower one arm's vertical rail for `ms`. dir in [-1,1], + = up.
  wait       Hold position for `ms`.
  play_audio Play a short audio CLIP on the robot's speaker from a URL (a CORS-enabled https:// URL or
             a data: URL to an audio file — clips only, not live streams). Use for a beep or a spoken
             line if the goal calls for it. Returns ok, or an error if the clip can't be fetched/decoded.
  done       Goal achieved — ends the run. Give a short summary.
  give_up    Goal unsafe or impossible — ends the run. Give the reason.

UNITS: rates are normalized to [-1,1]. ~0.3-0.5 is a gentle move; 0.6-0.8 is a normal working pace — use it freely; 1.0 is the max (further clamped by a half-speed session cap). Durations are milliseconds. Don't waste turns on needlessly tiny increments — take a real step, look, adjust.

VISION — READ CAREFULLY: you look at ONE camera at a time (see the `look` tool). If a "Camera layout" is provided, trust it for which tile is which camera/arm and act on the CORRECT side. A wrist camera is mounted ON its arm, so its image left/right is EGOCENTRIC and is NOT the robot's left/right — judge the robot's left vs right (and which side an object is on) from the OVERHEAD or FRONT scene cameras, never from a wrist camera. It is a single still, not depth — estimate coarsely, never assume exact distances. If no layout is given, state your assumption in text.

SAFETY (you cannot bypass these, but work WITH them): a human supervises with live video and an E-STOP; the daemon clamps joint ranges, latches on stall/over-temp, and safe-stops if the stream dies. You do NOT need to be timid — those layers plus the half-speed session cap are the safety net, so move at a normal working pace and take real steps rather than tiny ones; a run that inches along wastes turns. Still act sensibly: prefer `move_to` (bounded, reports blocked) over long open-loop jogs, keep base drives short, and if a `move_to` returns "blocked" do not shove into the same obstruction — re-look and rethink. Explain each action in text before the tool call so the supervisor can stop you.

Work step by step. One or a few tool calls per turn, then look and reassess. When the goal is achieved, call `done`."""


# The agent tool schemas are GENERATED from the SDK single-source-of-truth manifest
# (frontend/packages/nori-sdk/src/robot-ops.ts) into robot-tools.json, then loaded here — so the tools
# the model can call can never drift from what ScriptDriver/AgentSession actually dispatch. Edit the
# manifest, run `npm run gen:robot-tools`, and the change flows here with no server-side edit. The
# drift guard (frontend/src/nori/remote/robot-ops.drift.test.ts) fails CI if they diverge.
def _load_robot_tools_bundle() -> dict:
    """Locate + parse robot-tools.json. Works both from source (repo tree) and in the frozen desktop
    bundle (PyInstaller unpacks datas under sys._MEIPASS -> "nori-sdk/robot-tools.json"; see
    lelab_desktop.spec). Fails LOUD with a fix hint rather than silently shipping an empty tool list —
    an agent with no tools is a broken agent."""
    candidates = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(Path(meipass) / "nori-sdk" / "robot-tools.json")
    candidates.append(
        Path(__file__).resolve().parents[1] / "frontend" / "packages" / "nori-sdk" / "robot-tools.json"
    )
    for cand in candidates:
        if cand.is_file():
            return json.loads(cand.read_text(encoding="utf-8"))
    raise RuntimeError(
        "robot-tools.json not found (looked in: "
        + ", ".join(str(c) for c in candidates)
        + "). Generate it with `npm run gen:robot-tools` in frontend/, and make sure the desktop "
        "bundle ships it (lelab_desktop.spec datas)."
    )


# The tool SCHEMAS come from the manifest; the surrounding agent PEDAGOGY (NORI_AGENT_SYSTEM) stays
# hand-written on purpose. The browser dispatcher (AgentSession) implements each name.
NORI_AGENT_TOOLS = _load_robot_tools_bundle()["tools"]


class NoriLlmAgentBody(BaseModel):
    # The browser owns the conversation and sends the full Anthropic messages[] each turn (user goal,
    # assistant tool_use turns, and tool_result turns incl. `look` image blocks). Stateless server.
    messages: list[dict]
    robot_state: dict | None = None  # optional grounding: current proprioceptive pose
    camera_layout: str | None = None  # optional: which composite tile is which camera/arm
    # Optional explicit "first turn of a new run" signal for the backend's run_count.
    # If omitted, the server infers it from messages[] (no assistant turn yet).
    new_run: bool | None = None


# ---- agent daily token spend (cost governance — enforced per-customer in Nori-Backend) ----
#
# The browser enforces the PER-RUN caps (step + wall-clock). Per-DAY, per-CUSTOMER spend is now the
# authoritative cost guard and lives in Nori-Backend (migration 011 + routes/agent.py): a ledger keyed
# by customer, a hard daily cap (default 150k billable tokens = input+output) and a soft-warning line
# (default 100k). This endpoint no longer keeps a local counter — it GATES each turn against the
# backend before spending on Claude and CHARGES the real usage after, both behind the customer's
# forwarded JWT (X-Nori-JWT) so spend attributes to the right account.
#
# Cutover note: the old machine-local ~/.nori/agent_usage.json counter (shared, un-attributed, no hard
# limit) is GONE. Consequence: this endpoint now requires an authenticated request AND a reachable
# Nori-Backend — it fails closed (401/502) rather than falling back to an unbounded local counter,
# which is the point of the cap. See Nori-Backend/todos.md "Per-customer agent (LLM) token spend".


def _daily_view(budget: dict) -> dict:
    """Shape a Nori-Backend agent-budget snapshot into the `daily` field the browser consumes.
    Keeps `spent` (today's tokens) and `warn` (the soft-warning THRESHOLD number, so the existing
    `spent >= warn` banner logic is unchanged) and adds the now-enforced allowed/remaining/capped."""
    return {
        "spent": budget.get("used_today"),
        "allowed": budget.get("allowed_today"),
        "remaining": budget.get("remaining_today"),
        "warn": budget.get("soft_warn_threshold"),
        "capped": budget.get("hard_capped"),
    }


@app.post("/nori/llm/agent")
def nori_llm_agent(body: NoriLlmAgentBody, request: Request):
    """One turn of the agentic vision loop: inject the agent system prompt + tools, forward the
    browser-held messages[] to Claude, return the raw {stop_reason, content} for the browser to
    execute + append. Stateless — the browser drives the loop and enforces the per-run caps
    (step/wall-clock) and the confirm-before-first-motion gate (docs/agentic_vision_loop.md).

    COST GOVERNANCE (per-customer, enforced in Nori-Backend): the LLM proxy GATES before spending
    on Claude (429 if the customer is hard-capped for the day) and CHARGES the turn's real usage
    after, both behind the forwarded JWT — all server-side now. Requires auth + a reachable
    backend; there is no local key or fallback counter (fails closed)."""
    if not body.messages:
        raise HTTPException(status_code=400, detail="messages[] is required and must be non-empty")

    model = os.environ.get("NORI_LLM_MODEL", "claude-sonnet-5")

    # Fold optional grounding into the system prompt (a cacheable, stable-ish suffix) rather than
    # mutating the browser's messages[]. Keeps the conversation the browser holds untouched.
    system = NORI_AGENT_SYSTEM
    grounding = []
    if body.camera_layout:
        grounding.append(f"Camera layout (which composite tile is which): {body.camera_layout}")
    if body.robot_state:
        grounding.append(
            "Current robot state (proprioceptive, normalized): " + json.dumps(body.robot_state)
        )
    if grounding:
        system = system + "\n\nCONTEXT FOR THIS RUN:\n" + "\n".join(grounding)

    # new_run: honor an explicit browser signal, else infer "first turn" (no assistant turn yet).
    new_run = (
        body.new_run
        if body.new_run is not None
        else not any(m.get("role") == "assistant" for m in body.messages)
    )

    # Forward to the gated/metered proxy: it gates the budget (429), calls Claude with the
    # server-held key, charges the turn, and returns the raw assistant turn + updated budget.
    nori = _nori_client(request)
    result = _nori_proxy(
        lambda: nori.llm_messages(
            model=model,
            max_tokens=1500,
            system=system,
            tools=NORI_AGENT_TOOLS,
            messages=body.messages,
            new_run=bool(new_run),
        )
    )

    # content[] blocks (text + tool_use) are already plain JSON the browser appends verbatim as the
    # assistant turn. `daily` reflects the customer's backend-enforced budget (post-charge snapshot).
    return {
        "stop_reason": result.get("stop_reason"),
        "content": result.get("content", []),
        "usage": result.get("usage", {}),
        "daily": _daily_view(result.get("budget", {})),
    }


def nori_jwt(request: Request) -> str | None:
    """Extract the forwarded Supabase JWT from the inbound LeLab request.

    The browser sends it as `X-Nori-JWT`; Nori proxy endpoints (Phase 2+) pass it to
    NoriClient, which forwards it as `Authorization: Bearer ...` to Nori-Backend. LeLab
    never validates the token itself — Nori-Backend does (via JWKS).
    """
    return request.headers.get("X-Nori-JWT")


def _nori_client(request: Request) -> NoriClient:
    """Build a NoriClient carrying the inbound request's forwarded JWT."""
    return NoriClient(jwt=nori_jwt(request))


def _nori_proxy(call):
    """Run a NoriClient call, translating NoriBackendError into an HTTPException so the
    frontend sees Nori-Backend's status + detail unchanged instead of an opaque 500."""
    try:
        return call()
    except NoriBackendError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


NoriLeaderSide = Literal["left", "right"]
NoriLeaderAutoSide = Literal["left", "right", "both"]


class NoriLeaderPortSaveBody(BaseModel):
    left_port: str
    right_port: str | None = None


class NoriLeaderSetIdBody(BaseModel):
    target_id: int | None = None
    side: NoriLeaderSide | None = None
    joint: str | None = None
    port: str
    scan_max: int = 253


class NoriLeaderManualStartBody(BaseModel):
    side: NoriLeaderSide
    calibration_id: str = DEFAULT_LEADER_CALIBRATION_ID
    port: str | None = None


class NoriLeaderAutoStartBody(BaseModel):
    side: NoriLeaderAutoSide
    calibration_id: str = DEFAULT_LEADER_CALIBRATION_ID
    port: str | None = None
    confirm_powered: bool = False


class NoriLeaderDirectionBody(BaseModel):
    side: NoriLeaderSide
    joint: str
    mode: Literal["normal", "inverted"] | None = None
    calibration_id: str = DEFAULT_LEADER_CALIBRATION_ID


def _leader_guard(call):
    try:
        return call()
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=f"unknown key: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# NORI: local dual-leader setup. These endpoints only touch the laptop-attached
# leader arms; they deliberately do not connect to the robot core agent.
@app.get("/nori/leader/plan")
def nori_leader_plan():
    return {
        "left": expected_joint_ids("left"),
        "right": expected_joint_ids("right"),
        "default_calibration_id": DEFAULT_LEADER_CALIBRATION_ID,
    }


@app.get("/nori/leader/ports")
def nori_leader_ports(include_all: bool = False):
    return _leader_guard(lambda: {"success": True, "probes": probe_leader_ports(include_all=include_all)})


@app.post("/nori/leader/ports/auto-save")
def nori_leader_ports_auto_save():
    return _leader_guard(auto_save_detected_ports)


@app.post("/nori/leader/ports")
def nori_leader_ports_save(body: NoriLeaderPortSaveBody):
    return _leader_guard(lambda: save_ports_from_paths(body.left_port, body.right_port))


@app.post("/nori/leader/set-id")
def nori_leader_set_id(body: NoriLeaderSetIdBody):
    def run():
        close_shared_live_reader()
        target_id = body.target_id
        if target_id is None:
            if body.side is None or body.joint is None:
                raise ValueError("target_id or side+joint is required")
            target_id = expected_joint_ids(body.side)[body.joint]
        return set_connected_servo_id(
            target_id=target_id,
            port=body.port,
            scan_max=body.scan_max,
        )

    return _leader_guard(run)


@app.get("/nori/leader/identify")
def nori_leader_identify(port: str | None = None, all_ids: bool = False, cycles: int = 1):
    def run():
        close_shared_live_reader()
        return identify_leader_motors(port=port, all_ids=all_ids, cycles=cycles)

    return _leader_guard(run)


@app.post("/nori/leader/manual/start")
def nori_leader_manual_start(body: NoriLeaderManualStartBody):
    def run():
        close_shared_live_reader()
        return nori_leader_manual_manager.start(body.side, body.calibration_id, body.port)

    return _leader_guard(run)


@app.post("/nori/leader/manual/capture-center")
def nori_leader_manual_capture_center():
    def run():
        close_shared_live_reader()
        return nori_leader_manual_manager.capture_center()

    return _leader_guard(run)


@app.post("/nori/leader/manual/sample")
def nori_leader_manual_sample():
    def run():
        close_shared_live_reader()
        return nori_leader_manual_manager.sample()

    return _leader_guard(run)


@app.post("/nori/leader/manual/finish")
def nori_leader_manual_finish():
    return _leader_guard(nori_leader_manual_manager.finish)


@app.post("/nori/leader/manual/cancel")
def nori_leader_manual_cancel():
    return nori_leader_manual_manager.cancel()


@app.get("/nori/leader/manual/status")
def nori_leader_manual_status():
    return nori_leader_manual_manager.status()


@app.post("/nori/leader/auto/start")
def nori_leader_auto_start(body: NoriLeaderAutoStartBody):
    if not body.confirm_powered:
        raise HTTPException(status_code=400, detail="confirm auto calibration before starting")

    def run():
        close_shared_live_reader()
        return nori_leader_auto_manager.start(body.side, body.calibration_id, body.port)

    return _leader_guard(run)


@app.post("/nori/leader/auto/stop")
def nori_leader_auto_stop():
    return nori_leader_auto_manager.stop()


@app.get("/nori/leader/auto/status")
def nori_leader_auto_status():
    return nori_leader_auto_manager.get_status()


@app.get("/nori/leader/directions")
def nori_leader_directions(calibration_id: str = DEFAULT_LEADER_CALIBRATION_ID):
    return _leader_guard(lambda: list_nori_leader_directions(calibration_id))


@app.post("/nori/leader/directions")
def nori_leader_direction_set(body: NoriLeaderDirectionBody):
    return _leader_guard(
        lambda: set_nori_leader_direction(
            body.side,
            body.joint,
            mode=body.mode,
            calibration_id=body.calibration_id,
        )
    )


@app.get("/nori/leader/targets")
def nori_leader_targets(calibration_id: str = DEFAULT_LEADER_CALIBRATION_ID):
    return _leader_guard(lambda: read_live_targets(calibration_id))


@app.get("/nori/leader/live")
def nori_leader_live(port: str | None = None, calibration_id: str = DEFAULT_LEADER_CALIBRATION_ID):
    return _leader_guard(lambda: read_shared_live_positions(port=port, calibration_id=calibration_id))


@app.post("/nori/leader/live/stop")
def nori_leader_live_stop():
    return close_shared_live_reader()


# NORI: Nori-Backend proxy routes. The browser calls these same-origin (on the LeLab
# server); LeLab forwards the JWT to Nori-Backend. Response shapes pass through unchanged.
@app.post("/nori/customers/me/provision")
def nori_provision_customer(request: Request):
    client = _nori_client(request)
    return _nori_proxy(client.provision_customer)


@app.get("/nori/customers/me")
def nori_get_customer(request: Request):
    client = _nori_client(request)
    return _nori_proxy(client.get_customer)


# NORI: short-lived coturn TURN credentials (§2.4). Proxied to Nori-Backend with the
# forwarded JWT; the operator app fetches these at session start instead of holding a
# static secret. The static-auth-secret never touches LeLab or the browser.
@app.get("/nori/turn/credentials")
def nori_turn_credentials(request: Request):
    client = _nori_client(request)
    return _nori_proxy(client.get_turn_credentials)


# NORI: marketplace (Phase 3). Browse + acquire + download-to-local-cache. Running the
# downloaded policy against the robot (rollout) is blocked on the Pi.
@app.get("/nori/marketplace/policies")
def nori_list_policies(request: Request):
    client = _nori_client(request)
    return _nori_proxy(client.list_policies)


@app.get("/nori/marketplace/datasets/public")
def nori_list_public_datasets(request: Request):
    client = _nori_client(request)
    return _nori_proxy(client.list_public_datasets)


@app.get("/nori/datasets/mine")
def nori_list_my_datasets(request: Request):
    """The caller's promoted datasets, for the training dataset picker."""
    client = _nori_client(request)
    return _nori_proxy(client.list_my_datasets)


@app.delete("/nori/datasets/{session_id}")
def nori_delete_dataset(session_id: str, request: Request):
    """Permanently delete one of the caller's datasets (HF files + record)."""
    client = _nori_client(request)
    return _nori_proxy(lambda: client.delete_dataset(session_id))


class NoriLockBody(BaseModel):
    locked: bool


@app.post("/nori/datasets/{session_id}/lock")
def nori_set_dataset_lock(session_id: str, body: NoriLockBody, request: Request):
    """Lock/unlock a dataset (locked = can't rename or delete)."""
    client = _nori_client(request)
    return _nori_proxy(lambda: client.set_dataset_lock(session_id, body.locked))


# NORI: recording -> dataset assembly (raw_bundle promotion). The container-side
# assembly is airgapped + worker-driven; the frontend only enqueues + polls jobs
# and reads/edits provenance, so these are thin proxies.
@app.get("/nori/datasets/raw-bundles")
def nori_list_raw_bundles(request: Request):
    """The caller's robot recordings + on-robot pending count (My Stuff)."""
    client = _nori_client(request)
    return _nori_proxy(client.list_raw_bundles)


class NoriAssembleBody(BaseModel):
    sources: list[str]
    mode: str = "new"
    target_dataset_session_id: str | None = None
    name: str | None = None


@app.post("/nori/datasets/assemble")
def nori_assemble_dataset(body: NoriAssembleBody, request: Request):
    """Enqueue assembling recordings into a new dataset or appending to an existing one."""
    client = _nori_client(request)
    return _nori_proxy(lambda: client.assemble_dataset(
        body.sources, body.mode, body.target_dataset_session_id, body.name))


@app.get("/nori/datasets/assemblies/active")
def nori_active_assemblies(request: Request):
    """In-flight assembly jobs (for the 'Assembling' dataset badge + new-dataset placeholder)."""
    client = _nori_client(request)
    return _nori_proxy(client.active_assemblies)


@app.get("/nori/datasets/assemble/{assembly_job_id}")
def nori_get_assembly_job(assembly_job_id: str, request: Request):
    """Poll one assembly job's status."""
    client = _nori_client(request)
    return _nori_proxy(lambda: client.get_assembly_job(assembly_job_id))


@app.get("/nori/datasets/{dataset_session_id}/sessions")
def nori_dataset_sessions(dataset_session_id: str, request: Request):
    """Provenance sessions of an assembled dataset (for filter + bulk-delete)."""
    client = _nori_client(request)
    return _nori_proxy(lambda: client.dataset_sessions(dataset_session_id))


@app.delete("/nori/datasets/{dataset_session_id}/sessions/{session_key}")
def nori_delete_dataset_session(dataset_session_id: str, session_key: str, request: Request):
    """Bulk-delete a session's episodes (enqueues a reindex-safe rebuild)."""
    client = _nori_client(request)
    return _nori_proxy(lambda: client.delete_dataset_session(dataset_session_id, session_key))


class NoriDeleteEpisodesBody(BaseModel):
    episode_indices: list[int]


@app.post("/nori/datasets/{dataset_session_id}/delete-episodes")
def nori_delete_dataset_episodes(dataset_session_id: str, body: NoriDeleteEpisodesBody, request: Request):
    """Delete individual episodes by index (enqueues a reindex-safe rebuild)."""
    client = _nori_client(request)
    return _nori_proxy(lambda: client.delete_dataset_episodes(dataset_session_id, body.episode_indices))


@app.delete("/nori/library/policies/{job_id}")
def nori_delete_policy(job_id: str, request: Request):
    """Permanently delete one of the caller's policies (checkpoint + record)."""
    client = _nori_client(request)
    return _nori_proxy(lambda: client.delete_policy(job_id))


@app.post("/nori/library/policies/{job_id}/lock")
def nori_set_policy_lock(job_id: str, body: NoriLockBody, request: Request):
    """Lock/unlock a policy (locked = can't rename or delete)."""
    client = _nori_client(request)
    return _nori_proxy(lambda: client.set_policy_lock(job_id, body.locked))


@app.post("/nori/marketplace/policies/{listing_id}/acquire")
def nori_acquire_policy(listing_id: str, request: Request):
    client = _nori_client(request)
    return _nori_proxy(lambda: client.acquire_policy(listing_id))


@app.get("/nori/marketplace/policies/{ref}")
def nori_policy_details(ref: str, request: Request):
    """Full detail view for one policy (class, provenance, file manifest).

    Path mirrors the backend's GET /marketplace/policies/{ref} and the frontend
    client (getPolicyDetails), which both use the BARE path — not /details. The
    proxy route had drifted to /{ref}/details, so localhost 404'd on every
    marketplace detail open while prod (direct-to-backend) worked."""
    client = _nori_client(request)
    return _nori_proxy(lambda: client.get_policy_details(ref))


class NoriRenameBody(BaseModel):
    title: str | None = None


@app.patch("/nori/marketplace/policies/{ref}")
def nori_rename_policy(ref: str, body: NoriRenameBody, request: Request):
    """Rename an own trained policy (backend PII-scans + ownership-checks)."""
    client = _nori_client(request)
    return _nori_proxy(lambda: client.rename_policy(ref, body.title))


# NORI: community publishing (backend feature C). Publish requests create a
# pending_review listing (consent + review gated server-side); unpublish is an
# instant idempotent takedown; my-listings is the owner's submission view.
class NoriPublishBody(BaseModel):
    title: str
    description: str | None = None



@app.post("/nori/marketplace/policies/{ref}/publish")
def nori_publish_policy(ref: str, body: NoriPublishBody, request: Request):
    client = _nori_client(request)
    return _nori_proxy(lambda: client.publish_policy(ref, body.title, body.description))


@app.delete("/nori/marketplace/policies/{ref}/publish")
def nori_unpublish_policy(ref: str, request: Request):
    client = _nori_client(request)
    return _nori_proxy(lambda: client.unpublish_policy(ref))


@app.post("/nori/marketplace/datasets/{upload_ref}/publish")
def nori_publish_dataset(upload_ref: str, body: NoriPublishBody, request: Request):
    client = _nori_client(request)
    return _nori_proxy(lambda: client.publish_dataset(upload_ref, body.title, body.description))


@app.delete("/nori/marketplace/datasets/{upload_ref}/publish")
def nori_unpublish_dataset(upload_ref: str, request: Request):
    client = _nori_client(request)
    return _nori_proxy(lambda: client.unpublish_dataset(upload_ref))


@app.get("/nori/marketplace/my-listings")
def nori_my_listings(request: Request):
    client = _nori_client(request)
    return _nori_proxy(client.list_my_listings)


@app.post("/nori/marketplace/policies/{ref}/download")
def nori_download_policy(ref: str, request: Request):
    """Install the policy's FULL runnable bundle through LeLab into the local
    Nori cache: model.safetensors + config.json + pre/post-processor files,
    each sha256-verified against the backend's promotion-time manifest.
    Returns {ref, path, size_bytes, files} — `path` is the model file
    (backward-compatible); the cache dir is what rollout loads later.
    # NORI: switched from single-file download_policy to the manifest bundle
    # flow (backend routes /manifest + /files/{name}) so installed policies
    # are actually loadable by LeRobot from_pretrained."""
    client = _nori_client(request)
    dest = config.nori_policy_dir(ref)
    return _nori_proxy(lambda: client.download_policy_bundle(ref, dest))


# NORI: local policy cache management. These are LOCAL operations (they read /
# delete the on-disk nori_policies cache), NOT proxied to Nori-Backend — so
# they need no JWT and stay usable offline. The cache is what makes the
# "installed" state survive a page refresh (it's disk, not React state) and
# what `rollout.py._resolve_policy_path` loads a marketplace policy from.
@app.get("/nori/policies/local")
def nori_list_local_policies():
    """List installed marketplace policies (one dir per ref in the Nori cache).
    Returns [{ref, path, files: [{name, size_bytes}], size_bytes, runnable}].
    `runnable` = has model.safetensors (rollout can load it)."""
    root = Path(config.NORI_POLICY_CACHE)
    out: list[dict[str, Any]] = []
    if not root.is_dir():
        return out
    for d in sorted(root.iterdir()):
        if not d.is_dir():
            continue
        files = []
        total = 0
        for f in sorted(d.iterdir()):
            if f.is_file():
                sz = f.stat().st_size
                files.append({"name": f.name, "size_bytes": sz})
                total += sz
        out.append({
            "ref": d.name,
            "path": str(d),
            "files": files,
            "size_bytes": total,
            "runnable": (d / "model.safetensors").is_file(),
        })
    return out


@app.delete("/nori/policies/local/{ref}")
def nori_delete_local_policy(ref: str):
    """Remove one installed policy from the local cache. Idempotent (404 only
    if the ref escapes the cache dir; a missing ref returns deleted=false)."""
    root = Path(config.NORI_POLICY_CACHE).resolve()
    target = Path(config.nori_policy_dir(ref)).resolve()
    # Path-safety: nori_policy_dir sanitizes the ref, but confirm containment.
    if root not in target.parents:
        raise HTTPException(status_code=400, detail="invalid policy ref")
    if not target.is_dir():
        return {"ref": ref, "deleted": False}
    shutil.rmtree(target, ignore_errors=True)
    return {"ref": ref, "deleted": True}


# NORI: dataset upload (Phase 4). Reroutes the HF-direct push to the backend-mediated
# 4-step presigned-S3 flow. Runs synchronously (mirrors the existing /upload-dataset);
# long uploads block the request — background it later if needed. The producing pipeline
# (Pi binary-log pull + tools/export_lerobot_dataset.py) is the remaining Pi-blocked half.
class NoriDatasetUploadBody(BaseModel):
    repo_id: str
    commit_message: str | None = None


@app.post("/nori/datasets/upload")
def nori_upload_dataset(body: NoriDatasetUploadBody, request: Request):
    # Accept a local (on-disk) dataset OR one of the user's HF datasets — the
    # latter is downloaded to the local cache first (their HF login is used, so
    # private repos work), then uploaded through the same backend-mediated flow.
    try:
        local_path = dataset_browser.ensure_local_dataset(body.repo_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    client = _nori_client(request)

    def run():
        try:
            return client.upload_dataset(str(local_path), commit_message=body.commit_message)
        except ManifestError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return _nori_proxy(run)


# NORI: training dispatch + log polling (Phase 4). Backend-mediated: it holds the HF token
# and owns the HF Job; the laptop dispatches and polls. These also back the Phase 6
# training-history UI.
class NoriDispatchBody(BaseModel):
    timeout_seconds: int = 900
    # Resume a PAUSED backend job (training plan step 9). Forwarded verbatim;
    # the backend re-reserves usage for the fresh segment (402 when the
    # monthly allowance can't cover it -> surfaced to the UI as the alert).
    resume_from_job_id: str | None = None
    # CONTINUE a COMPLETED job to a NEW, higher step target (continue-from-
    # completed). Only meaningful alongside resume_from_job_id; the backend
    # requires it to exceed what the finished run already trained.
    steps: int | None = None


@app.post("/nori/training/dispatch")
def nori_dispatch_training(body: NoriDispatchBody, request: Request):
    client = _nori_client(request)
    payload: dict = {"timeout_seconds": body.timeout_seconds}
    if body.resume_from_job_id:
        payload["resume_from_job_id"] = body.resume_from_job_id
    if body.steps is not None:
        payload["steps"] = body.steps
    return _nori_proxy(lambda: client.dispatch_training(payload))


@app.post("/nori/training/jobs/{job_id}/stop")
def nori_stop_training_job(job_id: str, request: Request):
    """Safe pause: backend writes the job's S3 stop-flag; the trainer
    checkpoints and lands PAUSED within ~a minute."""
    client = _nori_client(request)
    return _nori_proxy(lambda: client.stop_job(job_id))


class NoriRenameUploadBody(BaseModel):
    label: str


@app.patch("/nori/datasets/upload/{session_id}")
def nori_rename_dataset_upload(session_id: str, body: NoriRenameUploadBody, request: Request):
    client = _nori_client(request)
    return _nori_proxy(lambda: client.rename_dataset_upload(session_id, body.label))


@app.get("/nori/library")
def nori_library(request: Request):
    """My Stuff: datasets + policies + lineage in one call."""
    client = _nori_client(request)
    return _nori_proxy(client.get_library)


@app.get("/nori/library/datasets/{session_id}/episodes")
def nori_dataset_episodes(session_id: str, request: Request):
    """Phase 2 cloud viewer: list a promoted dataset's episodes (+ a signed clip
    token) from the owner's HF repo. Clips are then fetched straight from the
    backend using that token, so only this JSON listing needs proxying."""
    client = _nori_client(request)
    return _nori_proxy(lambda: client.list_dataset_episodes(session_id))


class NoriJobNameBody(BaseModel):
    title: str | None = None


@app.patch("/nori/training/jobs/{job_id}/name")
def nori_rename_training_job(job_id: str, body: NoriJobNameBody, request: Request):
    client = _nori_client(request)
    return _nori_proxy(lambda: client.rename_training_job(job_id, body.title))


@app.get("/nori/training/estimate-params")
def nori_training_estimate_params(request: Request):
    """Constants for the training form's live time estimate (steps/s rates,
    setup allowance, tier max duration, pause/resume capability flag)."""
    client = _nori_client(request)
    return _nori_proxy(client.get_estimate_params)



@app.get("/nori/training/jobs")
def nori_list_jobs(request: Request):
    client = _nori_client(request)
    return _nori_proxy(client.list_jobs)


@app.get("/nori/training/jobs/{job_id}")
def nori_get_job(job_id: str, request: Request):
    client = _nori_client(request)
    return _nori_proxy(lambda: client.get_job(job_id))


@app.get("/nori/training/jobs/{job_id}/logs")
def nori_get_job_logs(job_id: str, request: Request, since: int = 0, tail: int | None = None):
    client = _nori_client(request)
    return _nori_proxy(lambda: client.get_job_logs(job_id, since=since, tail=tail))


@app.get("/nori/training/dataset-features")
def nori_dataset_features(request: Request, dataset_ref: str | None = None):
    """Camera/arm options for the training scope picker (data-driven from the
    selected dataset's features). dataset_ref omitted => the latest upload."""
    client = _nori_client(request)
    return _nori_proxy(lambda: client.get_dataset_features(dataset_ref))


# NORI: pairing + consents + deletion (Phase 6).
class NoriPairBody(BaseModel):
    robot_serial_number: str
    # Proof-of-possession code from the robot's box (backend migration 029). MUST be
    # carried through the proxy — without this field Pydantic silently drops it and the
    # backend rejects the claim with "needs its pairing code" even though the browser sent it.
    pair_code: str | None = None


@app.post("/nori/customers/me/pair")
def nori_pair_robot(body: NoriPairBody, request: Request):
    client = _nori_client(request)
    return _nori_proxy(lambda: client.pair_robot(body.robot_serial_number, body.pair_code))


class NoriUnpairBody(BaseModel):
    robot_serial_number: str | None = None


@app.post("/nori/customers/me/unpair")
def nori_unpair_robot(request: Request, body: NoriUnpairBody | None = None):
    client = _nori_client(request)
    serial = body.robot_serial_number if body else None
    return _nori_proxy(lambda: client.unpair_robot(serial))


@app.get("/nori/customers/me/robots")
def nori_list_robots(request: Request):
    client = _nori_client(request)
    return _nori_proxy(client.list_robots)


@app.post("/nori/customers/me/robots/{serial}/select")
def nori_select_robot(serial: str, request: Request):
    client = _nori_client(request)
    return _nori_proxy(lambda: client.select_robot(serial))


# NORI: billing summary (backend Phase 1, free-tier enforcement). Read-only
# tier + monthly compute + agent-token budgets for the Account page's Billing
# panel. Monthly fields arrive null until backend migration 013 is applied.
@app.get("/nori/billing/summary")
def nori_billing_summary(request: Request):
    client = _nori_client(request)
    return _nori_proxy(client.get_billing_summary)

@app.get("/nori/consents")
def nori_list_consents(request: Request):
    client = _nori_client(request)
    return _nori_proxy(client.list_consents)


class NoriConsentBody(BaseModel):
    consent_type: Literal["train_self", "publish_public"]
    policy_version: str
    scope_dataset_repo: str | None = None


@app.post("/nori/consents")
def nori_grant_consent(body: NoriConsentBody, request: Request):
    client = _nori_client(request)
    return _nori_proxy(
        lambda: client.grant_consent(
            body.consent_type, body.policy_version, body.scope_dataset_repo
        )
    )


class NoriConsentRevokeBody(BaseModel):
    reason: str | None = None


@app.post("/nori/consents/{consent_id}/revoke")
def nori_revoke_consent(consent_id: str, body: NoriConsentRevokeBody, request: Request):
    client = _nori_client(request)
    return _nori_proxy(lambda: client.revoke_consent(consent_id, body.reason))


class NoriDeletionBody(BaseModel):
    request_scope: Literal["full", "data_only"]
    notes: str | None = None


@app.post("/nori/deletion-requests")
def nori_create_deletion_request(body: NoriDeletionBody, request: Request):
    client = _nori_client(request)
    return _nori_proxy(lambda: client.create_deletion_request(body.model_dump()))


@app.get("/hf-auth-status")
def hf_auth_status():
    """Check whether the local HF CLI is authenticated and return user info."""
    return handle_hf_auth_status()


class HfLoginBody(BaseModel):
    token: str


@app.post("/hf-auth/login")
def hf_auth_login(body: HfLoginBody):
    """Persist a pasted HF token (validated against whoami) for this user."""
    try:
        return handle_hf_login(body.token)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


@app.get("/datasets")
def datasets_list():
    """List datasets available to the user — Hub-owned + local cache.

    Each entry carries a `source` field: "local", "hub", or "both".
    """
    return dataset_browser.list_all_datasets()


@app.get("/ws-test")
def websocket_test():
    """Test endpoint to verify WebSocket support"""
    return {"websocket_endpoint": "/ws/joint-data", "status": "available"}


@app.websocket("/ws/joint-data")
async def websocket_endpoint(websocket: WebSocket):
    logger.info("🔗 New WebSocket connection attempt")
    try:
        await manager.connect(websocket)
        logger.info("✅ WebSocket connection established")

        while True:
            # Keep the connection alive and wait for messages
            try:
                data = await asyncio.wait_for(websocket.receive_text(), timeout=1.0)
                # Handle any incoming messages if needed
                logger.debug(f"Received WebSocket message: {data}")
            except TimeoutError:
                # No message received, continue
                pass
            except WebSocketDisconnect:
                logger.info("🔌 WebSocket client disconnected")
                break

            # Small delay to prevent excessive CPU usage
            await asyncio.sleep(0.01)

    except WebSocketDisconnect:
        logger.info("🔌 WebSocket disconnected normally")
    except Exception as e:
        logger.error(f"❌ WebSocket error: {e}")
    finally:
        manager.disconnect(websocket)
        logger.info("🧹 WebSocket connection cleaned up")


@app.post("/start-recording")
def start_recording(request: RecordingRequest):
    """Start a dataset recording session"""
    return handle_start_recording(request)


@app.post("/stop-recording")
def stop_recording():
    """Stop the current recording session"""
    return handle_stop_recording()


@app.get("/recording-status")
def recording_status():
    """Get the current recording status"""
    return handle_recording_status()


@app.post("/recording-exit-early")
def recording_exit_early():
    """Skip to next episode (replaces right arrow key)"""
    return handle_exit_early()


@app.post("/recording-rerecord-episode")
def recording_rerecord_episode():
    """Re-record current episode (replaces left arrow key)"""
    return handle_rerecord_episode()


@app.post("/upload-dataset")
def upload_dataset(request: UploadRequest):
    """Upload dataset to HuggingFace Hub"""
    return handle_upload_dataset(request)


@app.post("/dataset-info")
def get_dataset_info(request: DatasetInfoRequest):
    """Get information about a saved dataset"""
    return handle_get_dataset_info(request)


@app.post("/delete-dataset")
def delete_dataset(request: DatasetInfoRequest):
    """Remove a recorded dataset directory from local disk."""
    return handle_delete_dataset(request)


# ============================================================================
# JOB ENDPOINTS
# ============================================================================


@app.post("/jobs/training", status_code=201)
async def create_training_job(req: Request):
    raw = await req.json()
    body = StartTrainingBody.from_legacy(raw)
    try:
        # NORI: forward the Supabase JWT so a nori_cloud target can dispatch + poll.
        record = job_registry.start(body.config, body.target, nori_jwt=nori_jwt(req))
    except JobAlreadyRunningError as exc:
        raise HTTPException(status_code=409, detail=f"Job already running: {exc}") from exc
    except NoriBackendError as exc:
        # NORI: a nori_cloud dispatch failed (bad/expired session, backend down).
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except ValueError as exc:
        # e.g. "flavor is required when runner is hf_cloud"
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return record


class ImportModelRequest(BaseModel):
    source: str
    name: str | None = None


@app.post("/jobs/import", status_code=201)
def import_model(body: ImportModelRequest):
    """Register an external model (local dir or HF repo) as a pseudo-job."""
    try:
        return job_registry.register_imported(body.source, body.name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/jobs")
def list_jobs(limit: int = 10):
    return {"jobs": job_registry.list(limit=limit)}


@app.get("/jobs/hub")
def list_hub_jobs():
    """List the user's HF Cloud compute Jobs and their uploaded LeRobot model
    repos on huggingface.co.

    Returns 200 with empty lists when no token is configured so the frontend
    can render an unauthenticated empty state without surfacing an error.

    Declared before `/jobs/{job_id}` so FastAPI's first-match routing doesn't
    treat "hub" as a job id.
    """
    info = cached_whoami()
    if info is None:
        return {"authenticated": False, "jobs": [], "models": []}
    api = shared_hf_api()

    authors: list[str] = []
    if info.get("name"):
        authors.append(info["name"])
    for o in info.get("orgs", []) or []:
        if isinstance(o, dict) and o.get("name"):
            authors.append(o["name"])

    try:
        jobs = api.list_jobs()
    except Exception as exc:
        logger.warning("list_jobs failed: %s", exc)
        jobs = []

    seen_models: set[str] = set()
    models: list[dict] = []
    for author in authors:
        try:
            for m in api.list_models(author=author, filter="LeRobot", limit=200):
                if m.id in seen_models:
                    continue
                seen_models.add(m.id)
                models.append(
                    {
                        "repo_id": m.id,
                        "last_modified": m.last_modified.isoformat() if m.last_modified else None,
                        "private": bool(getattr(m, "private", False)),
                    }
                )
        except Exception as exc:
            logger.warning("list_models(%s) failed: %s", author, exc)
    models.sort(key=lambda m: m["last_modified"] or "", reverse=True)

    return {
        "authenticated": True,
        "jobs": [
            {
                "id": ji.id,
                "created_at": ji.created_at.isoformat() if ji.created_at else None,
                "docker_image": ji.docker_image,
                "space_id": ji.space_id,
                "flavor": ji.flavor,
                "status": ({"stage": ji.status.stage, "message": ji.status.message} if ji.status else None),
                "owner": ji.owner.name if ji.owner else None,
                "url": ji.url,
            }
            for ji in jobs
        ],
        "models": models,
    }


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    try:
        return job_registry.get(job_id)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Job {job_id!r} not found") from exc


@app.get("/jobs/{job_id}/logs")
def get_job_logs(job_id: str):
    try:
        logs = job_registry.drain_logs(job_id)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Job {job_id!r} not found") from exc
    return {"logs": logs}


@app.get("/jobs/{job_id}/log-file")
def get_job_log_file(job_id: str):
    """Return the entire on-disk log file for a job. Drains the live queue too
    so the next /logs poll returns only lines that arrived after this call."""
    try:
        logs = job_registry.read_persisted_logs(job_id)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Job {job_id!r} not found") from exc
    # Best-effort drain so the frontend doesn't double-display.
    with contextlib.suppress(JobNotFoundError):
        job_registry.drain_logs(job_id)
    return {"logs": logs}


@app.get("/jobs/{job_id}/metrics-history")
def get_job_metrics_history(job_id: str):
    """Return the per-step loss/lr/grad-norm series reconstructed from the
    job's log.jsonl. Used to seed the monitoring charts so curves persist
    across page reloads, navigation, and lelab restarts."""
    try:
        points = job_registry.read_metrics_history(job_id)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Job {job_id!r} not found") from exc
    return {"points": points}


@app.get("/jobs/{job_id}/checkpoints")
def get_job_checkpoints(job_id: str):
    """List the checkpoints saved for this job, ascending by step."""
    try:
        return {"checkpoints": job_registry.list_checkpoints(job_id)}
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Job {job_id!r} not found") from exc


@app.get("/jobs/{job_id}/checkpoints/{step}/policy-config")
def get_checkpoint_policy_config(job_id: str, step: int):
    """Return the UX-relevant slice of a checkpoint's pretrained_model config:
    policy_type, image_features (per-camera height/width), and requires_task."""
    try:
        return job_registry.get_policy_config_summary(job_id, step)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Job {job_id!r} not found") from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/jobs/{job_id}/stop")
def stop_job(job_id: str):
    try:
        return job_registry.stop(job_id)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Job {job_id!r} not found") from exc
    except JobNotRunningError as exc:
        raise HTTPException(status_code=409, detail=f"Job {job_id!r} is not running") from exc


@app.delete("/jobs/{job_id}", status_code=204)
def delete_job(job_id: str):
    try:
        job_registry.delete(job_id)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Job {job_id!r} not found") from exc
    except JobNotRunningError as exc:
        raise HTTPException(status_code=409, detail=f"Job {job_id!r} is running; stop it first") from exc


@app.get("/jobs/runners/hardware")
def get_runners_hardware():
    """Return HF Jobs flavor catalog + auth state for the TargetCard.

    Both the flavors list and the whoami result are cached in-process to
    keep this endpoint cheap (it can be re-fetched whenever auth state
    changes). The whoami cache is invalidated on login.
    """
    info = cached_whoami()
    if info is None or not info.get("name"):
        return {"authenticated": False, "username": None, "flavors": []}
    username: str = info["name"]
    api = shared_hf_api()

    now = time.time()
    if _flavors_cache["data"] is None or now - _flavors_cache["fetched_at"] > _FLAVOR_CACHE_TTL_SECONDS:
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


# ============================================================================
# SYSTEM ENDPOINTS
# ============================================================================


@app.get("/system/cuda-status")
def get_cuda_status():
    """Report whether an NVIDIA GPU is present but PyTorch is CPU-only (issue #30)."""
    return handle_get_cuda_status()


@app.get("/system/training-extra")
def get_training_extra():
    """Return whether the LeRobot training extra (accelerate) is importable."""
    return handle_get_training_extra()


@app.post("/system/training-extra/install")
def install_training_extra():
    """Spawn `pip install accelerate` as a background subprocess. No-op if already running."""
    return handle_install_training_extra()


@app.get("/system/training-extra/install-status")
def install_training_extra_status():
    """Return current install state plus any pending log lines (drained on read)."""
    return handle_install_training_extra_status()


@app.get("/system/wandb-extra")
def get_wandb_extra():
    """Return whether the `wandb` package is importable in this lelab process."""
    return handle_get_wandb_extra()


@app.post("/system/wandb-extra/install")
def install_wandb_extra():
    """Spawn `pip install wandb` as a background subprocess. No-op if already running."""
    return handle_install_wandb_extra()


@app.get("/system/wandb-extra/install-status")
def install_wandb_extra_status():
    """Return current wandb install state plus any pending log lines (drained on read)."""
    return handle_install_wandb_extra_status()


@app.get("/system/update-check")
def update_check():
    """Report whether a newer LeLab commit exists on GitHub (cached, silent on failure)."""
    return handle_update_check()


@app.post("/system/update")
def run_update():
    """Run the pip upgrade in-process; the user must restart lelab afterwards."""
    return handle_run_update()


# Replay is rendered by the embedded lerobot/visualize_dataset Space; no backend routes needed.


# ============================================================================
# Calibration endpoints
@app.post("/start-calibration")
def start_calibration(request: CalibrationRequest):
    """Start calibration process"""
    return calibration_manager.start_calibration(request)


@app.post("/stop-calibration")
def stop_calibration():
    """Stop calibration process"""
    return calibration_manager.stop_calibration_process()


@app.get("/calibration-status")
def calibration_status():
    """Get current calibration status"""
    from dataclasses import asdict

    status = calibration_manager.get_status()
    return asdict(status)


@app.post("/complete-calibration-step")
def complete_calibration_step():
    """Complete the current calibration step"""
    return calibration_manager.complete_step()


@app.post("/start-auto-calibration")
def start_auto_calibration():
    """Start SO-101 auto calibration during range recording."""
    return calibration_manager.start_auto_calibration()


@app.get("/calibration-configs/{device_type}")
def get_calibration_configs(device_type: str):
    """Get all calibration config files for a specific device type"""
    try:
        if device_type == "robot":
            config_path = FOLLOWER_CONFIG_PATH
        elif device_type == "teleop":
            config_path = LEADER_CONFIG_PATH
        else:
            return {"success": False, "message": "Invalid device type"}

        # Get all JSON files in the config directory
        configs = []
        if os.path.exists(config_path):
            for file in os.listdir(config_path):
                if file.endswith(".json"):
                    config_name = os.path.splitext(file)[0]
                    file_path = os.path.join(config_path, file)
                    file_size = os.path.getsize(file_path)
                    modified_time = os.path.getmtime(file_path)

                    configs.append(
                        {
                            "name": config_name,
                            "filename": file,
                            "size": file_size,
                            "modified": modified_time,
                        }
                    )

        return {"success": True, "configs": configs, "device_type": device_type}

    except Exception as e:
        logger.error(f"Error getting calibration configs: {e}")
        return {"success": False, "message": str(e)}


@app.delete("/calibration-configs/{device_type}/{config_name}")
def delete_calibration_config(device_type: str, config_name: str):
    """Delete a calibration config file"""
    try:
        if device_type == "robot":
            config_path = FOLLOWER_CONFIG_PATH
        elif device_type == "teleop":
            config_path = LEADER_CONFIG_PATH
        else:
            return {"success": False, "message": "Invalid device type"}

        # config_name is interpolated into a filename, so reject path-traversal
        # characters (/, \, ..) before touching the filesystem. Defense-in-depth:
        # FastAPI path params already block a literal "/", but not "\" or "..".
        # Reuses the same guard already applied to robot-record deletes.
        if not is_valid_robot_name(config_name):
            return {"success": False, "message": "Invalid configuration name"}

        # Construct the file path
        filename = f"{config_name}.json"
        file_path = os.path.join(config_path, filename)

        # Check if file exists
        if not os.path.exists(file_path):
            return {"success": False, "message": "Configuration file not found"}

        # Delete the file
        os.remove(file_path)
        logger.info(f"Deleted calibration config: {file_path}")

        return {
            "success": True,
            "message": f"Configuration '{config_name}' deleted successfully",
        }

    except Exception as e:
        logger.error(f"Error deleting calibration config: {e}")
        return {"success": False, "message": str(e)}


# ============================================================================
# PORT DETECTION ENDPOINTS
# ============================================================================


@app.get("/available-ports")
def get_available_ports():
    """Get all available serial ports"""
    try:
        ports = find_available_ports()
        return {"status": "success", "ports": ports}
    except Exception as e:
        logger.error(f"Error getting available ports: {e}")
        return {"status": "error", "message": str(e)}


# Runs in a fresh Python — see _avfoundation_cameras_in_cv2_order for why.
# Mirrors OpenCV's macOS enumeration: video + muxed devices sorted by
# uniqueID (cap_avfoundation_mac.mm), so the returned index matches what
# cv2.VideoCapture will open.
_AVF_ENUM_SCRIPT = """
import json, objc
from Foundation import NSBundle
bundle = NSBundle.bundleWithPath_("/System/Library/Frameworks/AVFoundation.framework")
bundle.load()
types = []
for name in (
    "AVCaptureDeviceTypeBuiltInWideAngleCamera",
    "AVCaptureDeviceTypeExternalUnknown",   # macOS < 14
    "AVCaptureDeviceTypeExternal",          # macOS >= 14
    "AVCaptureDeviceTypeContinuityCamera",  # macOS >= 14
    "AVCaptureDeviceTypeDeskViewCamera",    # macOS >= 13
):
    loaded = {}
    try:
        objc.loadBundleVariables(bundle, loaded, [(name, b"@")])
    except objc.error:
        continue
    if loaded.get(name) is not None:
        types.append(loaded[name])
cls = objc.lookUpClass("AVCaptureDeviceDiscoverySession")
devs = []
for mt in ("vide", "muxx"):
    devs.extend(cls.discoverySessionWithDeviceTypes_mediaType_position_(types, mt, 0).devices() or [])
devs.sort(key=lambda d: d.uniqueID())
print(json.dumps([
    {"index": i, "name": str(d.localizedName()), "unique_id": str(d.uniqueID())}
    for i, d in enumerate(devs)
]))
"""


def _avfoundation_cameras_in_cv2_order() -> list[dict[str, Any]]:
    """Enumerate macOS cameras in a fresh Python subprocess.

    AVFoundation's in-process device cache doesn't refresh on USB
    hotplug. Both the deprecated ``+devicesWithMediaType:`` and a
    long-lived ``AVCaptureDeviceDiscoverySession`` go stale, because
    device-connection notifications are delivered via
    ``NSNotificationCenter`` on a thread that needs an active
    ``NSRunLoop`` — uvicorn workers don't run one. A fresh subprocess
    re-initializes AVFoundation, which reads IOKit's live device state
    at startup.
    """
    try:
        result = subprocess.run(
            [sys.executable, "-c", _AVF_ENUM_SCRIPT],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
    except (subprocess.SubprocessError, OSError) as e:
        logger.warning("AVFoundation enumeration subprocess failed: %s", e)
        return []
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as e:
        logger.warning("AVFoundation enumeration returned invalid JSON: %s", e)
        return []


def _generic_cv2_cameras(backend) -> list[dict[str, Any]]:
    """Last-resort enumeration: probe cv2 indices with placeholder names."""
    import cv2

    cameras: list[dict[str, Any]] = []
    for i in range(10):
        cap = cv2.VideoCapture(i, backend)
        opened = cap.isOpened()
        cap.release()
        if opened:
            cameras.append({"index": i, "name": f"Camera {i}", "available": True})
    return cameras


def _windows_cameras() -> list[dict[str, Any]]:
    """Enumerate Windows cameras with their real DirectShow names.

    pygrabber lists DirectShow video devices in the same order cv2's DSHOW
    backend indexes them (which recording is pinned to), so the returned index
    matches what ``cv2.VideoCapture(i, CAP_DSHOW)`` opens. The real names let the
    frontend match each index to the browser's ``MediaDeviceInfo.label`` for the
    live preview. Falls back to generic names if pygrabber is unavailable.
    """
    try:
        from pygrabber.dshow_graph import FilterGraph

        names = FilterGraph().get_input_devices()
    except Exception as e:  # ImportError, or a COM/DirectShow failure
        logger.warning("pygrabber unavailable; using generic camera names: %s", e)
        import cv2

        return _generic_cv2_cameras(cv2.CAP_DSHOW)
    return [{"index": i, "name": name, "available": True} for i, name in enumerate(names)]


def _v4l2_camera_name(index: int) -> str | None:
    """Real camera name for /dev/video{index} from sysfs (Linux, no deps)."""
    try:
        with open(f"/sys/class/video4linux/video{index}/name", encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


def _linux_cameras() -> list[dict[str, Any]]:
    """Enumerate Linux cameras, naming each from sysfs (no extra deps)."""
    import cv2

    cameras: list[dict[str, Any]] = []
    for i in range(10):
        cap = cv2.VideoCapture(i, cv2.CAP_V4L2)
        opened = cap.isOpened()
        cap.release()
        if not opened:
            continue
        cameras.append({"index": i, "name": _v4l2_camera_name(i) or f"Camera {i}", "available": True})
    return cameras


@app.get("/available-cameras")
def get_available_cameras():
    """List cameras with the same index ordering cv2 will use to record.

    Each platform enumerates in the order its cv2 backend indexes devices, and
    pairs each index with the device's real name so the frontend can match it to
    the browser's ``MediaDeviceInfo.label`` for the live preview:
      - macOS: AVFoundation ``localizedName`` (via a PyObjC subprocess);
      - Windows: DirectShow FriendlyName (via pygrabber; recording pinned DSHOW);
      - Linux: the v4l2 device name from sysfs.
    Without real names the frontend can't match a camera and shows "No browser
    match" with an empty device_id (issues #12, #16).
    """
    try:
        import platform

        system = platform.system()

        if system == "Darwin":
            cameras = _avfoundation_cameras_in_cv2_order()
            for cam in cameras:
                cam["available"] = True
            return {"status": "success", "cameras": cameras}
        if system == "Windows":
            return {"status": "success", "cameras": _windows_cameras()}
        if system == "Linux":
            return {"status": "success", "cameras": _linux_cameras()}

        import cv2

        return {"status": "success", "cameras": _generic_cv2_cameras(cv2.CAP_ANY)}
    except ImportError:
        logger.warning("OpenCV not available for camera detection")
        return {"status": "success", "cameras": []}
    except Exception as e:
        logger.error(f"Error detecting cameras: {e}")
        return {"status": "error", "message": str(e), "cameras": []}


RobotSideLiteral = Literal["leader", "follower"]


class PortDetectionBody(BaseModel):
    robot_type: RobotSideLiteral = "follower"


class PortDisconnectBody(BaseModel):
    ports_before: list[str]


class SaveRobotPortBody(BaseModel):
    robot_type: RobotSideLiteral
    port: str


class SaveRobotConfigBody(BaseModel):
    robot_type: RobotSideLiteral
    config_name: str


@app.post("/start-port-detection")
def start_port_detection(body: PortDetectionBody):
    """Snapshot available ports so the follow-up /detect-port-after-disconnect
    call can diff them."""
    result = find_robot_port(body.robot_type)
    return {"status": "success", "data": result}


@app.post("/detect-port-after-disconnect")
def detect_port_after_disconnect_endpoint(body: PortDisconnectBody):
    """Block up to 15s waiting for one port from `ports_before` to disappear."""
    try:
        detected_port = detect_port_after_disconnect(body.ports_before)
    except OSError as exc:
        raise HTTPException(status_code=408, detail=str(exc)) from exc
    return {"status": "success", "port": detected_port}


@app.post("/save-robot-port")
def save_robot_port_endpoint(body: SaveRobotPortBody):
    """Save a robot port for future use"""
    save_robot_port(body.robot_type, body.port)
    return {"status": "success", "message": f"Port {body.port} saved for {body.robot_type}"}


@app.get("/robot-port/{robot_type}")
def get_robot_port(robot_type: RobotSideLiteral):
    """Get the saved port for a robot type"""
    saved_port = get_saved_robot_port(robot_type)
    default_port = get_default_robot_port(robot_type)
    return {"status": "success", "saved_port": saved_port, "default_port": default_port}


@app.post("/save-robot-config")
def save_robot_config_endpoint(body: SaveRobotConfigBody):
    """Save a robot configuration for future use"""
    if not config.save_robot_config(body.robot_type, body.config_name):
        raise HTTPException(status_code=500, detail="Failed to save configuration")
    return {"status": "success", "message": f"Configuration saved for {body.robot_type}"}


@app.get("/robot-config/{robot_type}")
def get_robot_config(robot_type: RobotSideLiteral, available_configs: str = ""):
    """Get the saved configuration for a robot type"""
    available_configs_list = [c.strip() for c in available_configs.split(",") if c.strip()]
    saved_config = config.get_saved_robot_config(robot_type)
    default_config = config.get_default_robot_config(robot_type, available_configs_list)
    return {"status": "success", "saved_config": saved_config, "default_config": default_config}


# ============================================================================
# Robot config records (named robots)


def _record_with_clean(record: dict) -> dict:
    """Attach `is_clean` to a record for API responses."""
    return {**record, "is_clean": is_robot_record_clean(record)}


@app.get("/robots")
def get_robots():
    """List all saved robot records."""
    try:
        records = [_record_with_clean(r) for r in list_robot_records()]
        return {"status": "success", "robots": records}
    except Exception as e:
        logger.error(f"Error listing robots: {e}")
        return {"status": "error", "message": str(e), "robots": []}


@app.get("/robots/{name}")
def get_robot(name: str):
    """Get a single robot record by name."""
    if not is_valid_robot_name(name):
        return JSONResponse(status_code=400, content={"status": "error", "message": "Invalid robot name"})
    record = get_robot_record(name)
    if record is None:
        return JSONResponse(status_code=404, content={"status": "error", "message": "Robot not found"})
    return {"status": "success", "robot": _record_with_clean(record)}


@app.post("/robots/{name}")
def upsert_robot(name: str, data: dict, create: bool = False):
    """
    Upsert a robot record.

    - `?create=true` is the "Add Robot" path: returns 409 if a record with that
      name already exists; otherwise creates with empty fields then merges body.
    - Without `?create=true` is the "patch" path (e.g., calibration write-back):
      merges body into existing record. If no record exists, no-ops and returns
      success — see deletion-during-calibration edge case in the spec.
    """
    if not is_valid_robot_name(name):
        return JSONResponse(status_code=400, content={"status": "error", "message": "Invalid robot name"})
    try:
        if create:
            if get_robot_record(name) is not None:
                return JSONResponse(
                    status_code=409,
                    content={"status": "error", "message": "A robot with this name already exists"},
                )
            save_robot_record(name, data or {}, allow_create=True)
        else:
            save_robot_record(name, data or {}, allow_create=False)
        record = get_robot_record(name)
        if record is None:
            return {"status": "success", "robot": None}
        return {"status": "success", "robot": _record_with_clean(record)}
    except Exception as e:
        logger.error(f"Error upserting robot {name}: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@app.delete("/robots/{name}")
def delete_robot(name: str):
    """Delete a robot record."""
    if not is_valid_robot_name(name):
        return JSONResponse(status_code=400, content={"status": "error", "message": "Invalid robot name"})
    if delete_robot_record(name):
        return {"status": "success"}
    return JSONResponse(status_code=404, content={"status": "error", "message": "Robot not found"})


@app.on_event("startup")
def startup_event():
    """One-time startup diagnostics surfaced in the server terminal."""
    warn_if_cuda_mismatch()


@app.on_event("shutdown")
async def shutdown_event():
    """Clean up resources when FastAPI shuts down"""
    logger.info("🔄 FastAPI shutting down, cleaning up...")

    # Stop any active recording - handled by recording module cleanup

    if manager:
        manager.stop_broadcast_thread()
    logger.info("✅ Cleanup completed")


def _accepts_html(accept: str) -> bool:
    """Whether an Accept header explicitly wants text/html (quality > 0).

    Browser navigations list `text/html` with a positive quality value, so
    they get the SPA shell. A `text/html;q=0` entry is an explicit refusal and
    must not count — a plain substring check would wrongly treat it as a yes.
    `*/*` (curl, XHR, API clients) is deliberately not treated as wanting HTML.
    """
    for part in accept.split(","):
        media_type, _, params = part.strip().partition(";")
        if media_type.strip().lower() != "text/html":
            continue
        quality = 1.0
        for param in params.split(";"):
            key, _, value = param.partition("=")
            if key.strip().lower() == "q":
                try:
                    quality = float(value)
                except ValueError:
                    quality = 0.0
        return quality > 0
    return False


class SPAStaticFiles(StaticFiles):
    """StaticFiles that serves index.html for unknown client-side routes.

    The frontend is a single-page app: routes like /recording and /calibration
    exist only in the browser's router, not as files on disk. A hard reload or
    deep link to one of those URLs asks the server for a file that isn't there;
    plain StaticFiles answers 404 ({"detail":"Not Found"}), so the page breaks.

    Here we fall back to index.html on 404 so the SPA boots and its router
    renders the route. Only requests that accept HTML (i.e. browser navigations)
    get the fallback — API typos, XHR, and curl still receive a JSON 404.
    """

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code == 404 and _accepts_html(Headers(scope=scope).get("accept", "")):
                return await super().get_response("index.html", scope)
            raise


# Serve the built frontend at /. Must be mounted last so API routes win.
if FRONTEND_DIST.exists():
    app.mount("/", SPAStaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
else:
    logger.warning(
        f"frontend/dist not found at {FRONTEND_DIST}; run `npm run build` in frontend/ or use `lelab --dev`."
    )
