"""Fake adapter — tests/CI only (MODEL_KIND=fake). No GPU deps; lets the HTTP
surface (auth, contract validation, meta plumbing, error mapping) be exercised
with plain fastapi TestClient. Returns a deterministic ramp chunk."""

from __future__ import annotations

import numpy as np
from fastapi import HTTPException

from adapters.base import resolve_source


class FakeAdapter:
    HORIZON = 5
    DOF = 6

    def __init__(self, model_path: str):
        self._source = resolve_source(model_path, "fake://none")

    def load(self) -> None:
        pass

    def meta(self) -> dict:
        return {"kind": "fake", "chunk_hz": 15.0, "horizon": self.HORIZON,
                "dof": self.DOF, "cameras": ["wrist", "third_person"],
                "max_images": 2, "source": self._source,
                "supports_point": False, "supports_rtc": False}

    def act(self, *, images, state, instruction, num_steps, extras):
        if len(state) != self.DOF:
            raise HTTPException(status_code=422, detail=f"state must be {self.DOF}-dim")
        base = np.asarray(state, dtype=np.float32)
        chunk = np.stack([base + 0.1 * (i + 1) for i in range(self.HORIZON)])
        rtc_note = ({"skipped": "unsupported for policy kind fake"}
                    if extras.get("rtc") is not None else None)
        return chunk.astype(np.float32), {"rtc": rtc_note}
