"""GR00T N1.7 adapter — PLANNED third adapter (Gate B / step 5 note).

Not implemented yet: it lands with the GR00T finetune lane. When it does:
  - load via LeRobot's `groot` policy type (same factory pattern as pi05:
    PreTrainedConfig -> get_policy_class('groot') -> from_pretrained), which is
    N1.7-only at our pin. Inference fits A10G (16GB min, eager PyTorch).
  - image needs the groot extras (flash-attn >=2.5.9 prebuilt wheel,
    transformers 4.57.3) — heavier than the pi05 lane; the gated
    nvidia/Cosmos-Reason2-2B backbone must be prebaked (airgap).
  - chunk semantics from the checkpoint (chunk_size 16 / n_action_steps in the
    LeRobot config; horizon 40 native) — report via meta(), never assume.
  - LICENSE: serve N1.7 derivatives ONLY (N1.5/N1.6 are noncommercial);
    marketplace listings need the NVIDIA attribution lines.
"""

from __future__ import annotations


class GrootAdapter:
    def __init__(self, model_path: str):
        self._probe_path = model_path

    def load(self) -> None:
        raise NotImplementedError(
            "groot adapter lands with the GR00T finetune lane — see "
            "cloud_inference/serve/adapters/groot.py header and "
            "INFERENCE_ENDPOINT_PLAN Gate B")

    def meta(self) -> dict:  # pragma: no cover — unreachable until load() exists
        return {"kind": "groot", "supports_point": False, "supports_rtc": False}
