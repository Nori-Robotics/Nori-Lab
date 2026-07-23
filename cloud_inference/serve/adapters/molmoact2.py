"""MolmoAct2 adapter — a faithful port of the proven single-model server
(cloud_inference/space/molmoact2_server.py): same predict_action call, same
RTC per-session guidance cache, same OOM->507 behavior. Semantics UNCHANGED;
only the HTTP layer moved into serve/server.py."""

from __future__ import annotations

import os
import re
import time
from typing import Optional

import numpy as np
from fastapi import HTTPException

from adapters.base import resolve_source

REPO_ID = os.environ.get("MOLMOACT_REPO", "allenai/MolmoAct2-SO100_101")
NORM_TAG = os.environ.get("MOLMOACT_NORM_TAG", "so100_so101_molmoact2")
ACTION_HORIZON = 30          # this checkpoint's chunk length (30 moves @ 30 Hz)
CHUNK_HZ = 30.0
MAX_NUM_STEPS = 50
MAX_IMAGES = 6
_RTC_SESSION_CAP = 8


class MolmoAct2Adapter:
    def __init__(self, model_path: str):
        self._probe_path = model_path
        self._source: Optional[str] = None
        self._model = None
        self._processor = None
        self._rtc_state = None
        self._rtc_prev: dict = {}    # session id -> previous normalized chunk
        self._dtype = None

    def load(self) -> None:
        import torch
        from transformers import AutoModelForImageTextToText, AutoProcessor

        import rtc as rtcmod

        self._dtype = (torch.bfloat16
                       if os.environ.get("MOLMOACT_BF16", "1") == "1" else torch.float32)
        self._source = resolve_source(self._probe_path, REPO_ID)
        print(f"[molmoact2] loading from {self._source}", flush=True)
        proc = AutoProcessor.from_pretrained(self._source, trust_remote_code=True)
        model = (AutoModelForImageTextToText
                 .from_pretrained(self._source, trust_remote_code=True, dtype=self._dtype)
                 .to("cuda").eval())
        self._rtc_state = rtcmod.RTCState()
        try:
            if rtcmod.install_rtc(model, self._rtc_state) is None:
                print("[molmoact2] RTC: flow loop not found — serving un-guided", flush=True)
        except Exception as exc:
            print(f"[molmoact2] RTC install failed ({exc}) — serving un-guided", flush=True)
        self._processor, self._model = proc, model

    def meta(self) -> dict:
        return {"kind": "molmoact2", "chunk_hz": CHUNK_HZ, "horizon": ACTION_HORIZON,
                "dof": 6, "cameras": ["wrist", "third_person"],
                "max_images": MAX_IMAGES, "source": self._source,
                "norm_tag": NORM_TAG, "supports_point": True, "supports_rtc": True}

    def act(self, *, images, state, instruction, num_steps, extras):
        import torch
        import rtc as rtcmod

        num_steps = max(1, min(int(num_steps), MAX_NUM_STEPS))
        rtc_req = extras.get("rtc")
        rtc_horizon = None
        rtc_note = None
        if rtc_req is not None:
            rtc_horizon = rtcmod.pick_execution_horizon(
                int(rtc_req.get("delay", 0)), ACTION_HORIZON)
            if rtc_horizon is None:
                rtc_note = (f"skipped: delay {rtc_req.get('delay')} too large for "
                            f"horizon {ACTION_HORIZON} (needs d <= H/2)")
        use_rtc = rtc_req is not None and rtc_horizon is not None
        cuda_graph = False if use_rtc else bool(extras.get("enable_cuda_graph", True))
        grad_ctx = (torch.enable_grad()
                    if (use_rtc or extras.get("enable_grad")) else torch.no_grad())
        st = self._rtc_state
        try:
            with grad_ctx:
                if use_rtc:
                    session = str(rtc_req.get("session"))
                    st.prev = self._rtc_prev.get(session)
                    st.enabled = st.prev is not None
                    st.consumed = max(0, int(rtc_req.get("consumed", 0)))
                    st.delay = max(0, int(rtc_req.get("delay", 0)))
                    st.execution_horizon = rtc_horizon
                    st.applied = 0
                out = self._model.predict_action(
                    processor=self._processor, images=list(images), task=instruction,
                    state=state, norm_tag=NORM_TAG,
                    inference_action_mode="continuous", num_steps=num_steps,
                    normalize_language=True, enable_cuda_graph=cuda_graph)
                if use_rtc:
                    if (len(self._rtc_prev) >= _RTC_SESSION_CAP
                            and session not in self._rtc_prev):
                        self._rtc_prev.pop(next(iter(self._rtc_prev)))
                    self._rtc_prev[session] = st.prev
                    rtc_note = {"guided_steps": st.applied, "execution_horizon": rtc_horizon,
                                "delay": st.delay, "consumed": st.consumed,
                                "had_target": bool(st.enabled)}
                    st.prev = None
                    st.enabled = False
        except torch.cuda.OutOfMemoryError as e:
            torch.cuda.empty_cache()
            raise HTTPException(status_code=507, detail=f"CUDA OOM: {e}") from e
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        acts = out.actions
        if torch.is_tensor(acts):
            acts = acts.detach().float().cpu().numpy()
        return np.asarray(acts, dtype=np.float32), {
            "rtc": (rtc_note if isinstance(rtc_note, dict)
                    else ({"skipped": rtc_note} if rtc_note else None))}

    def point(self, *, image, query, max_new_tokens) -> dict:
        import torch
        from PIL import Image

        img = Image.fromarray(image)
        prompt = f"Point to {query}."
        t0 = time.time()
        try:
            with torch.inference_mode():
                try:
                    inputs = self._processor.apply_chat_template(
                        [{"role": "user",
                          "content": [{"type": "image", "image": img},
                                      {"type": "text", "text": prompt}]}],
                        add_generation_prompt=True, tokenize=True,
                        return_dict=True, return_tensors="pt")
                except Exception:
                    inputs = self._processor.process(images=[img], text=prompt)
                    inputs = {k: (v.unsqueeze(0) if hasattr(v, "dim") and v.dim() in (1, 3) else v)
                              for k, v in inputs.items()}
                inputs = {k: (v.to(self._model.device) if hasattr(v, "to") else v)
                          for k, v in inputs.items()}
                out = self._model.generate(**inputs, max_new_tokens=int(max_new_tokens))
                n_in = inputs["input_ids"].shape[1] if "input_ids" in inputs else 0
                text = self._processor.tokenizer.decode(out[0][n_in:], skip_special_tokens=False)
        except Exception as exc:
            raise HTTPException(status_code=500,
                                detail=f"pointing failed: {type(exc).__name__}: {exc}")
        pts = [[float(x), float(y)] for x, y in
               re.findall(r'x\d*="([0-9.]+)"\s+y\d*="([0-9.]+)"', text)]
        return {"raw": text, "points": pts,
                "compute_ms": round((time.time() - t0) * 1000.0, 1)}
