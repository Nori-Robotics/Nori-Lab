// NORI: Parked training-config fields.
//
// These are settings the LeLab/LeRobot trainer understands but Nori-Backend's
// `DispatchRequest` does NOT honor yet (or forces server-side). We keep them OUT
// of the visible ConfigForm so the UI only shows what actually affects a Nori
// cloud training run — but nothing is lost:
//   * the full form state still carries these defaults (so the LeLab job record
//     keeps recording the complete config), and
//   * this file is the single place to re-surface a field later.
//
// To re-enable a parked field once the backend supports it:
//   1. add its input back to ConfigForm.tsx, and
//   2. add its key to HONORED_DISPATCH_KEYS in ./types.ts.

/**
 * Every policy the LeRobot trainer can build. Nori-Backend currently whitelists
 * ONLY "act" (nori-backend compute/schemas/detect.py → DETECTORS; the promotion
 * validator uses the same registry). So the visible form locks to ACT. Re-add
 * options to FEASIBLE_POLICY_OPTIONS in ./types.ts as detectors land server-side.
 */
export const FULL_POLICY_OPTIONS: { value: string; label: string }[] = [
  { value: "act", label: "ACT (Action Chunking Transformer)" },
  { value: "diffusion", label: "Diffusion Policy" },
  { value: "pi0", label: "PI0" },
  { value: "smolvla", label: "SmolVLA" },
  { value: "tdmpc", label: "TD-MPC" },
  { value: "vqbet", label: "VQ-BeT" },
  { value: "pi0_fast", label: "PI0 Fast" },
  { value: "sac", label: "SAC" },
  { value: "reward_classifier", label: "Reward Classifier" },
];

/**
 * Defaults for fields the form no longer renders. Each notes WHY it's parked so
 * the reason is obvious when someone comes to re-enable it.
 */
export const PARKED_TRAINING_DEFAULTS = {
  // Forced `cuda` server-side in the training container (orchestrator
  // _build_training_script). A browser-chosen device is meaningless.
  policy_device: "cuda",

  // Optimizer is driven by the policy training preset server-side; none of these
  // are in DispatchRequest, so they have no effect on a cloud run.
  optimizer_type: "adam",
  optimizer_lr: undefined as number | undefined,
  optimizer_weight_decay: undefined as number | undefined,
  optimizer_grad_clip_norm: undefined as number | undefined,
  use_policy_training_preset: true,

  // Checkpointing is server-managed: v1 saves only the final checkpoint
  // (save_freq = steps), always saves it, and has no resume-from-checkpoint.
  save_freq: 1000,
  save_checkpoint: true,
  resume: false,

  // W&B is forced off (no per-customer W&B identity on backend compute).
  wandb_enable: false,
  wandb_disable_artifact: false,

  // The backend trains on the customer's OWN dataset (selected via dataset_ref,
  // a promoted upload) — never an arbitrary typed-in HF repo. Parked so the
  // legacy free-text field isn't lost if we ever expose "bring your own repo".
  dataset_repo_id: "",
};
