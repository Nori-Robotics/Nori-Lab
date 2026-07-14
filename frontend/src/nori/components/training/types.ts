// NORI: Additive file. Shared training-form types + defaults for the Nori side.
// Kept out of the component files so fast-refresh stays component-only.

import type { NoriTrainingConfig } from "@/nori/api/client";
import { PARKED_TRAINING_DEFAULTS } from "./parkedConfig";

/** Form state: the full LeLab config + Nori-only duration + dataset selection. */
export type NoriTrainingFormState = NoriTrainingConfig & {
  timeout_seconds: number;
  /** Which promoted dataset upload to train on (backend `dataset_ref`).
   *  undefined => backend uses the customer's latest promoted upload. */
  dataset_ref?: string;
  /** Train on one of Nori's published open datasets instead (backend
   *  `open_dataset_id`). Mutually exclusive with dataset_ref. */
  open_dataset_id?: string;
};

/** Feasible policy options shown in the form. Backend whitelists ONLY "act"
 *  today (see parkedConfig.FULL_POLICY_OPTIONS for the parked remainder). */
export const FEASIBLE_POLICY_OPTIONS: { value: string; label: string }[] = [
  { value: "act", label: "ACT (Action Chunking Transformer)" },
];

/** Duration options. Free tier is capped at 900s; 1800/3600 need a paid tier
 *  (backend returns 402/422 otherwise), so they're rendered Pro-gated. */
export const DURATION_OPTIONS: { label: string; seconds: number; pro: boolean }[] = [
  { label: "15 minutes", seconds: 900, pro: false },
  { label: "30 minutes", seconds: 1800, pro: true },
  { label: "60 minutes", seconds: 3600, pro: true },
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
  policy_use_amp: false,
  log_freq: 250,
  timeout_seconds: 900,
  dataset_ref: undefined,
  open_dataset_id: undefined,
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
  return body;
}
