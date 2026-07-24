# HF Inference Endpoints: MolmoAct2 migration + a pi0.5 endpoint

> ASSIGNED 2026-07-23: **session 2 executes steps 3, 5, 6 + the training lanes**
> (multi-flavor HF Jobs layer + gated-repo prebakes) — user directive "add pi05
> and GR00T N1.7 before finetuning". Session 1 keeps live rollout + finetune
> data. Steps 1-2-4 stay blocked on the user's Endpoints-scoped token.
> ⚠️ Coordinate Space deploys between sessions — a restart is ~10-15 min of
> endpoint downtime and kills live robot runs.
>
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

**Gate A — L4 latency. RESOLVED 2026-07-23: L4 PASSES — 292 ms median
compute (n=12 warm, real 640x480 robot frames, spread 290–294), marginally
FASTER than the 303 ms A10G baseline.** The bandwidth-bound prediction
(~450–600 ms) was wrong; the workload is not memory-bandwidth-limited.
Measured by flipping the production Space itself to `l4x1` (same container,
same code — org plan 402'd a throwaway Space). **Step-4 endpoint SKU = L4
gcp us-east4 $0.70/hr (≈$511/mo min-1).** The Space now RUNS on l4x1
($0.80/hr vs a10g's $1.00) — kept there since it measured equal-fast;
revert = request_space_hardware(a10g-small) + restart.

**Gate B — which pi0.5 checkpoint. RESOLVED 2026-07-22 by session-2's
research relay (memory: vla-model-landscape + vla-ops-plan).** `lerobot/
pi05_base` ships NO normalization stats — it cannot run zero-shot, full stop
(verified: empty `"features"`; every LeRobot base card says "fine-tune on
your use case"). Session 2 confirms the landscape: π-series has ZERO SO-101
coverage in pretraining (UR5e/Franka/Trossen/ARX only); no stats-bearing
SO-100 pi0.5 checkpoint exists anywhere; π*0.6 has no released weights; and
even on its OWN platform, `pi05_droid` true zero-shot measures 39.2% —
below MolmoAct2's 56.7% unseen-objects ceiling on SO-100. Verdict:
1. **There is no zero-shot pi0.5 for our robot.** MolmoAct2 stays the
   zero-shot baseline (only open model with SO-101 in pretraining + best
   published random-camera-pose robustness, 87.1% vs π0.5-DROID's 45.2%).
2. **The pi0.5 endpoint serves a Nori finetune** — and session 2 delivered
   the exact recipe: LeRobot `--policy.type=pi05` on `pi05_base` (NOT
   pi05_droid — wrong embodiment prior), full FT >70GB → a100-large
   $2.50/hr ≈ $10/run, or `--policy.train_expert_only=true` (~300M
   trainable) as the cheap tier. Footguns: QUANTILES norm needs q01/q99
   (`augment_dataset_quantile_stats.py` first; initial loss ~40,000 =
   stats missing — STOP); gated `google/paligemma-3b-pt-224` tokenizer
   must be prebaked for the airgap; keep max action dims 32 (issue #2963).
   ~154 eps/5k steps community proof → `move_red_cup_final` (127 eps)
   qualifies. License note: weights are GEMMA terms, not Apache.
3. **GR00T N1.7 (3B) is the top finetune challenger** (not pi0.5): ~50-ep
   post-train, ~35GB peak → l40sx1 $1.80/hr ≈ $5-10/run, LeRobot-native
   (`--policy.type=groot`, v3 datasets). The Phase-B `MODEL_KIND` adapter
   pattern should plan for a third `groot` adapter (inference fits A10G).
   N1.7 ONLY — N1.5/1.6 are noncommercial-licensed.
The serving architecture below is checkpoint-independent; Phase B's first
real payload is whichever finetune lands first (3-way on-robot A/B:
MolmoAct2 zero-shot vs GR00T-N1.7-FT vs pi05-FT is the target experiment).

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
3. **Auth.** Session-2 research (2026-07-22): `Authorization` is consumed
   by HF's edge on protected endpoints — custom headers DO pass through.
   So `X-Nori-Token` is the PRIMARY app-level credential (constant-time
   compare; `Authorization` still accepted for the Space-transition
   client); client sends both. Endpoint can start `type=protected`
   (HF-token at edge) + our header inside — defense in depth, and it kills
   the must-be-public Space wart outright.
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
| 4 | ✅ DONE 2026-07-23 — `molmoact2-l4` (L4 gcp us-east4, authenticated, min1/max2) live; validated (auth matrix + 315ms compute + observe-only robot run); `NORI_INFER_URL` flipped; Space PAUSED | 1–3 |
| 5 | Adapter refactor (`MODEL_KIND`) + pi05 adapter | Gate B checkpoint |
| 6 | pi0.5 endpoint (scale-to-zero OK) + `/load policy_kind` client wiring | 5 |
| 7 | Retire Space permanently once endpoint has a week of runs | 4 |

## 5. Open items / unverified

- `/repository` mount semantics with `trust_remote_code` custom code — the
  mount is documented; loading remote-code models FROM it needs one test.
- Real L4 latency for each model (Gate A).
- Endpoint quota for the org (the catalog showed quota 0 pre-token; assumed
  to follow the Endpoints entitlement).

Resolved 2026-07-22 (session-2 relay): Gate B (no zero-shot pi0.5 exists for
SO-101; endpoint serves a Nori finetune, recipes in Gate B above);
`Authorization` forwarding (edge consumes it; custom headers pass —
`X-Nori-Token` is primary). Session 2's ops plan also confirms scale-to-zero
cold requests 502 unless held with `X-Scale-Up-Timeout`, and pending-requests
scaling as the right metric for /act bursts — both already reflected above.
