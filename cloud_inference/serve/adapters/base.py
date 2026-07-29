"""Reference adapter contract (documentation — adapters are duck-typed).

An adapter owns everything model-specific: weights resolution (the /repository
mount vs its Hub fallback), preprocessing, the inference call, and its CHUNK
SEMANTICS. The server owns HTTP, auth, image decode, locking, and timing.

    class Adapter:
        def __init__(self, model_path: str): ...
            # model_path = the /repository probe location (may not exist)

        def load(self) -> None: ...
            # Heavy imports (torch/lerobot/transformers) happen HERE, not at
            # module import — the server must import light for tests.

        def act(self, *, images, state, instruction, num_steps, extras)
                -> tuple[np.ndarray, dict]: ...
            # images: list[np.ndarray HxWx3 uint8] in the order of meta()['cameras']
            # state:  np.float32 vector, robot scale (adapter normalizes)
            # returns (chunk [horizon x DOF] robot scale, extra dict e.g. {'rtc': ...})
            # Raise fastapi.HTTPException for contract errors (422/507-style).

        def meta(self) -> dict: ...
            # MUST include: kind, chunk_hz, horizon, dof, cameras (list of the
            # camera roles/keys this policy expects, in /act image order),
            # max_images, source (resolved weights location), joints (see
            # declared_joints below — REQUIRED for any Nori finetune).
            # The client reads this instead of assuming another model's constants.

        def point(self, *, image, query, max_new_tokens) -> dict: ...   # OPTIONAL

Shared helpers (weights resolution, joint contract) live here."""

from __future__ import annotations

import os
from pathlib import Path


def resolve_source(model_path: str, hub_fallback: str) -> str:
    """Prefer the platform-mounted weights dir (Inference Endpoints mount the
    endpoint's model repo at /repository); fall back to a Hub repo id."""
    p = Path(model_path)
    try:
        if p.is_dir() and any(p.iterdir()):
            return str(p)
    except OSError:
        pass
    return hub_fallback


def declared_joints() -> list[str]:
    """The endpoint's JOINT CONTRACT: the Nori telemetry keys this checkpoint's
    state/action vectors are ordered by, e.g.

        NORI_JOINT_NAMES="right_arm_elbow_flex.pos,right_arm_gripper.pos,..."

    WHY THIS EXISTS (2026-07-29). A checkpoint cannot report its own joint
    names — LeRobot's PolicyFeature carries only `type` and `shape`, and the
    names live in the DATASET, not the policy. Before this, the rollout client
    mapped every served model's action vector onto MolmoAct2's canonical order
    (shoulder_pan, shoulder_lift, elbow_flex, wrist_flex, wrist_roll, gripper).
    A Nori finetune emits the ORDER ITS DATASET USED (ours is alphabetical:
    elbow_flex, gripper, shoulder_lift, shoulder_pan, wrist_flex, wrist_roll),
    so that mapping silently scrambles the arm.

    Declaring joints ALSO declares the convention: a model that speaks Nori
    joint names is trained in Nori joint space, so the client applies NO units
    calibration and NO model-space bounds (both are MolmoAct2 zero-shot
    conventions that would corrupt a finetune). Empty list = undeclared; the
    client then keeps per-kind legacy behaviour for molmoact2 and REFUSES to
    load any other kind rather than guess an order.

    Set this on the endpoint/Space to the SAME order the training dataset's
    observation.state used (for a scoped policy, the scoped subset's order)."""
    raw = os.environ.get("NORI_JOINT_NAMES", "")
    return [j.strip() for j in raw.split(",") if j.strip()]
