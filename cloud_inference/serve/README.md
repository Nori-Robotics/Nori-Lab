# Nori multi-policy inference server (`serve/`)

Step 5 of `../INFERENCE_ENDPOINT_PLAN.md`: one image, model **adapters**, one
policy kind per running container (`MODEL_KIND`). Supersedes the single-model
`../space/` server at the step-4/6 cutover — until then `space/` stays the live
Space artifact; **do not deploy this over the Space without coordinating with
session 1** (live robot runs).

## Kinds

| MODEL_KIND | payload | status |
|---|---|---|
| `molmoact2` | `allenai/MolmoAct2-SO100_101` (zero-shot baseline) | ported unchanged from `space/` (RTC, `/point`, OOM→507) |
| `pi05` | a **Nori pi05 finetune** (Gate B: `pi05_base` has no stats and cannot serve); smoke: `jcoholich/pi05_droid_converted` | implemented; needs GPU smoke |
| `groot` | GR00T **N1.7** finetune (license: N1.7 only) | stub — lands with the finetune lane |
| `fake` | none | tests/CI only |

## The frozen `/act` contract (adapters extend, never break)

```
POST /act { images:[b64...], state:[floats], instruction, num_steps? }
  -> { actions:[[DOF] x horizon], compute_ms, rtc?, meta? }
```

`meta` (also in `/health`) carries the PER-POLICY chunk semantics —
`{kind, chunk_hz, horizon, dof, cameras, ...}`. **Clients must read it**: pi05
is horizon-50 at the training dataset's rate (`NORI_CHUNK_HZ`, default 15 for
the Nori fleet), NOT MolmoAct2's 30 Hz × 30. `cameras` lists the image order
`/act` expects. `/point` 501s on kinds without a pointing backbone.

## Auth / health / weights (same as step 3)

`X-Nori-Token` primary (constant-time; `Authorization: Bearer` kept for the
transition — on a protected endpoint the edge consumes Authorization).
`/ready` = 503-until-loaded (endpoint `health_route`); `/` + `/health` stay
200-while-loading (Space probe). Weights load from the `/repository` mount when
present, else the kind's Hub fallback (`MOLMOACT_REPO` / `NORI_PI05_CHECKPOINT`).

## Build / run

```bash
docker build --build-arg MODEL_KIND=pi05 -t nori-serve-pi05 .
docker run --gpus all -p 7860:7860 \
  -e MODEL_KIND=pi05 -e NORI_INFER_TOKEN=... \
  -e NORI_PI05_CHECKPOINT=jcoholich/pi05_droid_converted \
  -e NORI_CHUNK_HZ=15 nori-serve-pi05
```

Endpoint creation values: see `../space/DEPLOY.md` §Inference Endpoint
(SKU per Gate A: **L4 gcp us-east4 — measured 292 ms, faster than A10G**).
pi05 endpoints MAY scale-to-zero (marketplace experiments — cold start is a UX
cost); the live-control MolmoAct2 endpoint must stay `min_replica=1`.

## Tests

`tests/test_cloud_serve.py` exercises the HTTP surface with `MODEL_KIND=fake`
(no GPU deps). GPU smokes for real kinds run inside the image.
