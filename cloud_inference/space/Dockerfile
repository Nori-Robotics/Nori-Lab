# MolmoAct2-SO100_101 cloud-inference server as a HuggingFace **Docker** Space.
#
# WHY A DOCKER SPACE (not an Inference Endpoint): the managed Inference-Endpoint
# container bakes in `huggingface_inference_toolkit`, whose bootstrap imports
# `transformers.file_utils.is_tf_available` — REMOVED in the transformers >=4.57
# that MolmoAct2's processor requires (it needs `transformers.video_utils`). The
# two are mutually exclusive, so the toolkit path is a dead end. A Docker Space
# runs OUR uvicorn directly — the toolkit never enters the picture, and we own
# the exact transformers version.
#
# Base image = the SAME torch stack proven on HF Jobs (torch 2.5.1 + cu121):
# pinning transformers on top of it does NOT upgrade torch, so torchvision /
# torchaudio ABIs stay intact (the "-U torchvision" ABI break we hit earlier).
FROM pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime

# HF Spaces run the container as uid 1000 with $HOME=/home/user. Point every
# cache at a writable dir so the ~21GB model download doesn't hit a read-only FS.
ENV HOME=/home/user \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/home/user/.cache/huggingface \
    HF_HUB_ENABLE_HF_TRANSFER=1

# libGL / glib for PIL+torchvision image ops; ffmpeg libs for PyAV (av) decode.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libgl1 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 user

WORKDIR /app
COPY --chown=user:user requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt hf_transfer

COPY --chown=user:user molmoact2_server.py .
# RTC guidance core — imported by the server; without this the container
# dies on `import rtc` at startup.
COPY --chown=user:user rtc.py .

RUN mkdir -p /home/user/.cache/huggingface && chown -R user:user /home/user /app
USER user

# HF Spaces expose the container on 7860 (declared as app_port in README.md).
EXPOSE 7860
CMD ["uvicorn", "molmoact2_server:app", "--host", "0.0.0.0", "--port", "7860"]
