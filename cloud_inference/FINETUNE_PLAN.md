# MolmoAct2 → Nori finetune plan (joints + cameras)

## Why finetune (and why calibration isn't enough)
The live check (`scratchpad/livecheck.py`, `move_red_left` ep0) showed MolmoAct2
out-of-box has an open-loop error of ~20.9° that a **per-joint affine calibration**
cuts to ~2.1° — so **~90% of the gap is a linear joint-convention difference**, not
a deep domain gap. Calibration (`derive_calibration.py` → `NORI_INFER_CALIB`) is a
good **stopgap** and is now wired into the rollout. But it has real limits:
- It's fit from ONE capture's distribution; it assumes a *linear* convention map
  and can drift on poses/tasks outside that distribution.
- It does **nothing** for the **camera domain gap** — MolmoAct2 trained on RealSense
  top/side rigs; Nori's `overhead`/`front` differ in mount, intrinsics, lighting.
  The 2° residual and any harder/reactive task will be dominated by this.

A **finetune** fixes both natively: the model relearns Nori's joint convention AND
Nori's camera viewpoints, so no calibration layer is needed. The checkpoint is
explicitly "intended for both inference and **further fine-tuning**."

## What we already have (assets)
- **Captures in the right shape**: `move_red_left`, `new_test`, `asdfghj` (LeRobot
  v3.0, 15fps, `observation.images.{overhead,front,left_wrist,right_wrist}`,
  **absolute joint pose in degrees**, per-camera H.264 preview sidecars).
- **Single-arm slicing**: `lelab/policy_scope.py` already slices a bimanual capture
  to a 6-DoF single arm by name prefix (`actuators=["left"]`) — the exact 6 joints
  MolmoAct2 wants.
- **The eval harness**: `dryrun_cloud.py --dataset` / `livecheck.py` give a per-joint
  open-loop error metric — reuse it as the finetune's offline scorecard.
- **Compute path**: HF Jobs / AWS GPU (see the AWS migration, task #39).

## Data prep (Nori capture → MolmoAct2 finetune format)
Per episode, emit exactly what `predict_action` consumes:
1. **State/action**: the single arm's 6 joints in the model's canonical order
   (`shoulder_pan, shoulder_lift, elbow_flex, wrist_flex, wrist_roll, gripper`),
   absolute pose, degrees. Use `policy_scope` to select the arm; reorder to model
   order (see `nori_cloud_rollout.arm_keys`). **Do NOT pre-apply the calibration** —
   the finetune should learn Nori's raw convention.
2. **Images**: the 2 external views (`overhead`, `front`). Camera order is free.
   Drop the wrist views (the checkpoint is a 2-external-view model) unless we choose
   to add views (a heavier architecture change — start with 2).
3. **Language**: one annotated instruction per episode (lowercased, no trailing
   punctuation — matches `normalize_language`). Nori captures need an instruction
   field; add a per-dataset/episode task string at capture or as a labeling pass.
4. **norm_stats**: recompute Nori-specific stats and register a **new `norm_tag`**
   (e.g. `nori_l2_molmoact2`) so normalization matches Nori's distribution — this is
   what makes calibration unnecessary post-finetune. `derive_calibration.py`'s stats
   code is a starting point.

## Finetune procedure
1. **Code**: `github.com/allenai/molmoact2` (confirm the finetune entrypoint + config).
   Start from `allenai/MolmoAct2-SO100_101` (not the base) to keep SO-100/101 priors.
2. **Regime**: LoRA / adapter finetune FIRST (cheap, fast, low forgetting risk).
   Escalate to partial or full finetune only if LoRA under-fits.
3. **Data mix**: optionally mix a little original SO-100/101 data with Nori data to
   avoid catastrophic forgetting; start Nori-only and check.
4. **Compute**: finetuning a 5B VLA needs more than the A10G we infer on — plan for
   1×A100/H100 (LoRA) or multi-GPU (full). Sequence with the AWS training move (#39);
   HF Jobs can host the run meanwhile.
5. **Scale**: begin with the captures we have (tens of episodes); collect more per
   target task. VLAs finetune reasonably on small in-domain sets.

## Camera setup (for replicability + a better finetune)
- **Mount `overhead` + `front` on fixed rigs** and keep them stable across capture
  and deployment — the model keys off consistent external viewpoints.
- Positioning them to loosely resemble the training **top/side** framing helps both
  zero-shot and finetune convergence, but isn't required — the finetune adapts to
  whatever fixed Nori views we standardize on.
- Record calibration/mount notes with each dataset so the deployment cameras match
  the finetune cameras (a viewpoint change post-finetune reintroduces the gap).

## Eval + rollout gating
1. **Offline**: `dryrun_cloud.py --dataset` per-joint error on a HELD-OUT episode;
   target < ~5° across all joints (from the ~2° calibrated baseline, better).
2. **Sim/bench**: replay predicted chunks against held-out demos before hardware.
3. **Real**: cautious open-loop on the arm behind the daemon safety envelope
   (bounds/watchdog/e-stop), short chunks first.

## Phasing
- **A (done/now)** — calibration stopgap wired in; enables a first *cautious* real
  test with `NORI_INFER_CALIB` set.
- **B** — collect + instruction-annotate a Nori finetune set (existing captures +
  targeted new ones); build the format-export (policy_scope + 2 views + norm_stats).
- **C** — LoRA finetune from `MolmoAct2-SO100_101`; eval with the harness; drop the
  calibration layer once error is low.
- **D** — scale data / full finetune if needed; standardize camera rigs; real rollout.
