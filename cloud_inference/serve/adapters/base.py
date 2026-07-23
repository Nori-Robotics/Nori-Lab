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
            # max_images, source (resolved weights location).
            # The client reads this instead of assuming another model's constants.

        def point(self, *, image, query, max_new_tokens) -> dict: ...   # OPTIONAL

Weights resolution helper shared by all adapters lives here."""

from __future__ import annotations

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
