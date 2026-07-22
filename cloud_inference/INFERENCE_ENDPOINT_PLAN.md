# HF Inference Endpoints: MolmoAct2 migration + a pi0.5 endpoint

> Status 2026-07-22: PLAN. Decision made: stay on HuggingFace (cloud-provider
> research 2026-07-22 recommends HF-inference-now regardless of the eventual
> training answer). This plan migrates the MolmoAct2 Docker Space to a real
> Inference Endpoint (autoscaling, cheaper, no more pause/credit stalls) and
> stands up a pi0.5 endpoint behind the same serving pattern.
>
> Verified foundations (2026-07-21/22 research — do not re-derive):
> custom-container Endpoints bypass the `transformers==4.51.3` toolkit pin
> entirely; `create_inference_endpoint(custom_image=…, min/max_replica,
> scaling_metric, scale_to_zero_timeout, secrets, env)` is all in the API;
> live catalog: **L4 24GB $0.70/hr (gcp us-east4)**, A10G $1.00/hr (aws
> us-east-1), L40S 48GB $1.80/hr; weights should come from the platform's
> `/repository` mount, not baked or Hub-fetched at boot.

## 0. The two decision gates (settle BEFORE building)

**Gate A — L4 latency.** Our 303 ms/request is measured on A10G (~600 GB/s
memory bandwidth). L4 is ~300 GB/s and a 5B bf16 decode is bandwidth-bound —
expect ~450–600 ms. Still inside the 1 s chunk budget, but halves headroom.
**Measure on a throwaway L4 endpoint before choosing the SKU**; fallback is
A10G at $1.00/hr (same price as the Space, plus autoscaling).

**Gate B — which pi0.5 checkpoint.** `lerobot/pi05_base` ships NO
normalization stats — it cannot run zero-shot, full stop (verified: empty
`"features"`; every LeRobot base card says "fine-tune on your use case").
Options, in order of realism:
1. **openpi `pi05_droid`** — ships DROID stats; genuinely runs without
   finetuning, but for DROID-class (Franka) setups. Serves marketplace
   customers with that hardware; does NOT drive our SO-101-class robot.
2. **A Nori-finetuned pi0.5** — the real path for OUR robot (session-2
   training Tracks 2/3: flavor layer + backbone-through-the-airgap). The
   endpoint built here serves it the day it exists.
3. If newer research surfaces a stats-bearing SO-100 pi0.5 checkpoint, slot
   it in here — none found as of 2026-07-22.
The plan builds the endpoint + adapter for whichever checkpoint passes this
gate; the serving architecture is checkpoint-independent.

## 1. Prerequisite (user action, blocks everything)

The org token has `repo.*` + `job.write` but **no Inference Endpoints scope**
(the verified 403). Mint a fine-grained org token with Endpoints
read/write. Note billing: Endpoints bill pay-as-you-go, which also ends the
Space's prepaid-credit stalls (the 402 incident).

## 2. Phase A — migrate MolmoAct2 (Space → Endpoint)

The Space's Dockerfile is already ~portable. Deltas:

1. **Weights from `/repository`.** Create the endpoint with
   `repository="allenai/MolmoAct2-SO100_101"` + our custom image; server
   checks `MODEL_PATH=/repository` first, falls back to the Hub download
   (keeps the same image runnable as a Space during transition). This is the
   cold-start fix: platform-mounted weights instead of a 21 GB download.
2. **Port + health.** Declare the container port explicitly (mismatch = the
   documented #1 "stuck initializing" cause). Our `/health` already has the
   right semantics (200 only when loaded, 503 while loading).
3. **Auth.** Whether HF's gateway forwards `Authorization` to custom
   containers is UNVERIFIED (the Space forced-public wart's cousin). Server
   gains `X-Nori-Token` (checked with the same constant-time compare,
   `Authorization` still accepted); client sends both. Endpoint starts
   `type=public` (our bearer still gates /act — same posture as the Space);
   flip to `authenticated` only after verifying header forwarding.
4. **Create** (values, not vibes):
   - instance: per Gate A — L4 gcp us-east4 or A10G aws us-east-1
   - `min_replica=1` — scale-to-zero is UNUSABLE for a control loop (5–6 min
     cold start with failing requests during scale-out; documented)
   - `max_replica=2`, `scaling_metric=pendingRequests` (HF's recommended
     leading indicator), `scaleToZeroTimeout` explicitly unset/disabled
   - `secrets={"NORI_INFER_TOKEN": …}` — proper secret handling, and rotation
     becomes an API call + rolling restart
5. **Cutover.** `NORI_INFER_URL` is the single switch (client is
   host-agnostic by design). Sequence: create endpoint → warm validation
   (200/401/422 + latency A/B vs the Space on real 29 KB frames) → flip
   `.env` → one observe-only robot run → **pause the Space** (ends the
   $1/hr-when-awake burn).
6. **Known multi-replica caveat:** server-side RTC session cache assumes one
   replica. RTC is default-off and measured non-viable on this GPU class, so
   `max_replica=2` is safe today — but if RTC is ever enabled, it needs
   sticky sessions or `max_replica=1`. Recorded here so it isn't rediscovered.

Cost: L4 min-1 ≈ **$511/mo** vs Space $730 — cheaper AND autoscaling AND no
credit-pause failure mode. A10G min-1 = cost parity with today plus all of
the above.

## 3. Phase B — the pi0.5 endpoint

1. **Serving pattern: one image, model adapters.** Generalize
   `molmoact2_server.py` into `serve/` with a `MODEL_KIND` env:
   - `molmoact2` adapter = today's `predict_action` path, unchanged.
   - `pi05` adapter = LeRobot ≥0.6 `policies.pi05` (or openpi runtime for
     `pi05_droid`) behind the SAME `/act` contract:
     `{images, state, instruction, num_steps?} → {actions, compute_ms}`.
   - Do NOT use LeRobot's PolicyServer (pickle-on-wire CVE — standing rule).
2. **Sizing:** pi0.5 is ~3.6B, 9–11 GB bf16 → fits L4 comfortably (and is
   less bandwidth-starved than the 5B MolmoAct2 — Gate A may pass for pi05
   even if it fails for MolmoAct2).
3. **Per-policy chunk semantics.** The client already parameterizes
   `chunk_hz`/stride (built for MolmoAct2's 30 Hz×30). `/load` gains a
   `policy_kind` that maps to per-policy `{chunk_hz, horizon, joint contract,
   camera contract}` — pi0.5-DROID's action space/rate differs and MUST NOT
   inherit MolmoAct2's constants silently.
4. **Topology: separate endpoint per model** (not multiplexed): independent
   scaling and failure domains, and the pi0.5 endpoint CAN use
   scale-to-zero if it serves marketplace experiments rather than a live
   control loop — its cold start is a UX cost, not a safety one. Usage-only
   billing ≈ near-$0 idle.
5. **Rollout gating:** whichever checkpoint passes Gate B, first hardware
   contact follows the MolmoAct2 playbook: observe-only, cmd-vs-obs logging,
   the daemon's stall/clamp verdicts, stop-and-stare first.

## 4. Order of work

| # | step | needs |
|---|---|---|
| 1 | Mint Endpoints-scoped token | user |
| 2 | Throwaway L4 endpoint; measure MolmoAct2 latency (Gate A) | token |
| 3 | Server deltas: `/repository` weights, port decl, `X-Nori-Token` | nothing |
| 4 | MolmoAct2 endpoint (SKU per Gate A); validate; flip `NORI_INFER_URL`; pause Space | 1–3 |
| 5 | Adapter refactor (`MODEL_KIND`) + pi05 adapter | Gate B checkpoint |
| 6 | pi0.5 endpoint (scale-to-zero OK) + `/load policy_kind` client wiring | 5 |
| 7 | Retire Space permanently once endpoint has a week of runs | 4 |

## 5. Open items / unverified

- `Authorization` forwarding on custom-container endpoints (mitigated by
  `X-Nori-Token` regardless).
- `/repository` mount semantics with `trust_remote_code` custom code — the
  mount is documented; loading remote-code models FROM it needs one test.
- Real L4 latency for each model (Gate A).
- Which pi0.5 checkpoint (Gate B) — blocked on session-2's research if it
  exists beyond the recorded training relay; nothing found in repos as of
  2026-07-22.
- Endpoint quota for the org (the catalog showed quota 0 pre-token; assumed
  to follow the Endpoints entitlement).
