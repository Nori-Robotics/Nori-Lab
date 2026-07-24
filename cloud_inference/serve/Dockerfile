# Nori multi-policy inference image (INFERENCE_ENDPOINT_PLAN step 5).
#
# ONE Dockerfile, per-kind requirements via build arg:
#   docker build --build-arg MODEL_KIND=molmoact2 -t nori-serve-molmoact2 .
#   docker build --build-arg MODEL_KIND=pi05      -t nori-serve-pi05 .
# Run with env MODEL_KIND matching the build arg (the arg only picks which
# requirements file is installed; the env picks the adapter at boot).
#
# Base = the SAME proven torch stack as the Space (torch 2.5.1 + cu121); never
# reinstall torch/torchvision/torchaudio on top (ABI break, see space/Dockerfile).
FROM pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime

ARG MODEL_KIND=molmoact2

ENV HOME=/home/user \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/home/user/.cache/huggingface \
    HF_HUB_ENABLE_HF_TRANSFER=1 \
    MODEL_KIND=${MODEL_KIND}

# ffmpeg for av decode; git for the pinned lerobot install (pi05 kind).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libgl1 libglib2.0-0 git && \
    rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 user
WORKDIR /app

COPY --chown=user:user requirements-${MODEL_KIND}.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt hf_transfer

COPY --chown=user:user server.py rtc.py ./
COPY --chown=user:user adapters/ ./adapters/

RUN mkdir -p /home/user/.cache/huggingface && chown -R user:user /home/user /app
USER user

# PORT: Spaces route to 7860; Inference Endpoints take the port from the
# endpoint config — declare 7860 there, or set PORT. health_route=/ready.
EXPOSE 7860
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-7860}"]
