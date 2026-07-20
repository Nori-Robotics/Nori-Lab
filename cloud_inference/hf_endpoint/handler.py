"""
HuggingFace Inference Endpoint custom handler for MolmoAct2-SO100_101 (task #38).

Deploy this in a small HF *handler repo* (just handler.py + requirements.txt);
the endpoint's container downloads the 5B model by ID at startup. HF Endpoints
provide the GPU, HTTPS, and token auth — so unlike the AWS FastAPI variant there's
no auth/uvicorn code here, just load + predict.

Request (POST to the endpoint URL, header: Authorization: Bearer <HF_TOKEN>):
    { "inputs": { "images": [b64,...], "state": [6 floats], "instruction": str,
                  "num_steps": 10 } }
Response:
    { "actions": [[...DOF...], ...] }   # a 10-30 move chunk, ROBOT SCALE
"""

import base64
import io

import numpy as np
import torch
from PIL import Image
from transformers import AutoModelForImageTextToText, AutoProcessor

REPO_ID = "allenai/MolmoAct2-SO100_101"
NORM_TAG = "so100_so101_molmoact2"


class EndpointHandler:
    def __init__(self, path: str = "") -> None:
        # HF endpoint has a GPU + network + HF token; load the model by ID
        # (this repo ships only the handler, not the weights). bf16 fits <16GB.
        self.processor = AutoProcessor.from_pretrained(REPO_ID, trust_remote_code=True)
        self.model = (
            AutoModelForImageTextToText.from_pretrained(
                REPO_ID, trust_remote_code=True, dtype=torch.bfloat16
            )
            .to("cuda")
            .eval()
        )

    @staticmethod
    def _decode(b64: str) -> np.ndarray:
        if b64.lstrip().startswith("data:") and "," in b64[:64]:
            b64 = b64.split(",", 1)[1]
        return np.asarray(Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB"))

    def __call__(self, data: dict) -> dict:
        inp = data.get("inputs", data)
        images = [self._decode(b) for b in inp["images"]]
        state = np.asarray(inp["state"], dtype=np.float32)
        instruction = inp["instruction"]
        num_steps = int(inp.get("num_steps", 10))
        with torch.no_grad():
            out = self.model.predict_action(
                processor=self.processor,
                images=images,
                task=instruction,
                state=state,
                norm_tag=NORM_TAG,
                inference_action_mode="continuous",
                num_steps=num_steps,
                normalize_language=True,
                enable_cuda_graph=True,
            )
        acts = out.actions
        if torch.is_tensor(acts):  # predict_action returns a CUDA tensor — move to host first
            acts = acts.detach().float().cpu().numpy()
        acts = np.asarray(acts, dtype=np.float32)
        if acts.ndim == 3 and acts.shape[0] == 1:  # (1, chunk, DOF) -> (chunk, DOF)
            acts = acts[0]
        return {"actions": acts.tolist()}
