// NORI: Additive file. Shared training-form types + defaults for the Nori side.
// Kept out of the component files so fast-refresh stays component-only.

import type { NoriTrainingConfig } from "@/nori/api/client";

/** Form state: the forwarded config plus the Nori-only training duration. */
export type NoriTrainingFormState = NoriTrainingConfig & {
  timeout_seconds: number;
};

export const DEFAULT_TRAINING_CONFIG: NoriTrainingFormState = {
  dataset_repo_id: "",
  policy_type: "act",
  steps: 10000,
  batch_size: 8,
  seed: 1000,
  num_workers: 4,
  log_freq: 250,
  save_freq: 1000,
  save_checkpoint: true,
  resume: false,
  // W&B isn't surfaced in the Nori UI (backend-managed compute); keep it off.
  wandb_enable: false,
  wandb_disable_artifact: false,
  policy_device: "cuda",
  policy_use_amp: false,
  optimizer_type: "adam",
  use_policy_training_preset: true,
  timeout_seconds: 900,
};
