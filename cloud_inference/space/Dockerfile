# MolmoAct2-SO100_101 cloud-inference server as a HuggingFace **Docker** Space.
#
# WHY A DOCKER SPACE (not a managed Inference Endpoint): the managed container
# bakes in `huggingface_inference_toolkit`, which HARD-PINS transformers==4.51.3.
# That predates `transformers.video_utils.VideoInput` (added in 4.57.0), which
# MolmoAct2's trust_remote_code processor imports — so the managed image simply
# cannot satisfy the model. A Docker Space runs OUR uvicorn directly: no toolkit,
# and we own the exact transformers version.
#
# CORRECTION (2026-07-21): this comment previously blamed the toolkit importing
# `transformers.file_utils.is_tf_available`, said to be "REMOVED in >=4.57". That
# is false — is_tf_available is present through 4.57.3 and only disappears in
# v5.0.0. The version floor below is right; only the reason was wrong. Note the
# managed path may still be reachable with a CUSTOM container image, which
# bypasses the toolkit entirely — untested here.
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
