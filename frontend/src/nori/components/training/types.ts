// NORI: Additive file. Shared training-form types + defaults for the Nori side.
// Kept out of the component files so fast-refresh stays component-only.

import type { NoriTrainingConfig } from "@/nori/api/client";
import { PARKED_TRAINING_DEFAULTS } from "./parkedConfig";

/** Camera/arm scope for a policy (backend DispatchRequest.scope). Empty/omitted
 *  fields => whole robot / all cameras. `actuators` are "left"|"right" (or
 *  "both"/"whole"); `cameras` are short names from the dataset's features. */
export type TrainingScope = {
  actuators?: string[];
  cameras?: string[];
};

/** Form state: the full LeLab config + Nori-only duration + dataset selection. */
export type NoriTrainingFormState = NoriTrainingConfig & {
  timeout_seconds: number;
  /** Which promoted dataset upload to train on (backend `dataset_ref`).
   *  undefined => backend uses the customer's latest promoted upload. */
  dataset_ref?: string;
  /** Train on one of Nori's published open datasets instead (backend
   *  `open_dataset_id`). Mutually exclusive with dataset_ref. */
  open_dataset_id?: string;
  /** Name the resulting policy BEFORE training (backend `policy_name` →
   *  jobs.display_title). Renameable later from My Stuff at any stage. */
  policy_name?: string;
  /** Optional camera/arm scope; undefined => whole-robot, all-camera policy. */
  scope?: TrainingScope;
};

/** Feasible policy options shown in the form — classes VERIFIED end-to-end in
 *  the training container (whitelisted ≠ verified: the backend accepts
 *  everything detect.py recognizes, but only these have proven container
 *  runs + POLICY_STEP_RATES rows). Parked remainder: parkedConfig. */
export const FEASIBLE_POLICY_OPTIONS: { value: string; label: string }[] = [
  { value: "act", label: "ACT (Action Chunking Transformer)" },
  { value: "diffusion", label: "Diffusion Policy" },
];

/** "Max training duration" options. Which are selectable is tier-driven: the
 *  form disables any option above the caller's max_timeout_seconds (from
 *  GET /training/estimate — free 900s, pro 3600s, developer unlimited). The
 *  "Unlimited" seconds MUST equal the backend's UNLIMITED_JOB_TIMEOUT_SECONDS. */
export const UNLIMITED_DURATION_SECONDS = 86400; // 24h — matches backend ceiling
export const DURATION_OPTIONS: { label: string; seconds: number }[] = [
  { label: "15 minutes", seconds: 900 },
  { label: "30 minutes", seconds: 1800 },
  { label: "60 minutes", seconds: 3600 },
  { label: "Unlimited", seconds: UNLIMITED_DURATION_SECONDS },
];

export const DEFAULT_TRAINING_CONFIG: NoriTrainingFormState = {
  // Parked fields carry through the state (LeLab records them) but aren't shown.
  ...PARKED_TRAINING_DEFAULTS,

  // ---- feasible: shown in the form AND wired to the backend DispatchRequest ----
  policy_type: "act",
  // Must FIT the default 900s duration under the backend fit-gate (floor
  // 8 steps/s => max 7200); 10000 was born-rejected. Mirrors the backend
  // DispatchRequest default.
  steps: 5000,
  batch_size: 8,
  num_workers: 4,
  seed: 1000,
  // AMP on by default — a near-free ~1.5-2x speedup + lower GPU memory on the
  // GPUs HF Jobs runs, and ACT is numerically robust to it. Especially helps
  // multi-camera datasets (e.g. the 3-cam move_red_cup_split), whose activation
  // memory is ~Ncam x a single-camera run.
  policy_use_amp: true,
  log_freq: 250,
  timeout_seconds: 900,
  dataset_ref: undefined,
  open_dataset_id: undefined,
  policy_name: undefined,
  scope: undefined,
};

/** The keys the backend `DispatchRequest` actually honors. Everything else in
 *  the form state is parked and omitted from the dispatch body. Add a key here
 *  ONLY once the backend schema consumes it. */
export const HONORED_DISPATCH_KEYS = [
  "policy_type",
  "steps",
  "batch_size",
  "num_workers",
  "seed",
  "policy_use_amp",
  "log_freq",
  "timeout_seconds",
  "dataset_ref",
  "open_dataset_id",
  "policy_name",
  "scope",
] as const;

/** Build the backend dispatch body from form state: only the honored fields,
 *  with dataset_ref omitted when unset (=> backend picks the latest upload). */
export function toDispatchBody(c: NoriTrainingFormState): Record<string, unknown> {
  const body: Record<string, unknown> = {
    policy_type: c.policy_type,
    steps: c.steps,
    batch_size: c.batch_size,
    num_workers: c.num_workers,
    seed: c.seed,
    policy_use_amp: c.policy_use_amp,
    log_freq: c.log_freq,
    timeout_seconds: c.timeout_seconds,
  };
  // Mutually exclusive sources: an open-dataset pick wins (the picker clears
  // dataset_ref when selecting one, but guard here too — the backend 422s on
  // both being present).
  if (c.open_dataset_id) body.open_dataset_id = c.open_dataset_id;
  else if (c.dataset_ref) body.dataset_ref = c.dataset_ref;
  if (c.policy_name?.trim()) body.policy_name = c.policy_name.trim();
  // Scope only when it actually narrows something (empty => whole robot).
  if (c.scope && ((c.scope.actuators?.length ?? 0) > 0 || (c.scope.cameras?.length ?? 0) > 0)) {
    body.scope = c.scope;
  }
  return body;
}
