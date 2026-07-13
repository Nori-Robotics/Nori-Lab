// NORI: Additive file. Typed client for Nori-Backend, reached *through* the LeLab
// Python server's `/nori/*` proxy routes (same origin as the rest of the app). The
// browser attaches the Supabase JWT as `X-Nori-JWT`; LeLab forwards it to Nori-Backend
// as `Authorization: Bearer ...`. See NORI_PLAN.md "Auth model".
//
// Response shapes come from `./types.ts`, auto-generated from Nori-Backend's openapi.json
// (regenerate with `npm run gen:types`).

import { apiRequest, type Fetcher, type ApiRequestOptions } from "@/lib/apiClient";
import { getAccessToken } from "@/nori/auth/session";
import type { components } from "@/nori/api/types";
import type { JobRecord, TrainingRequest } from "@/lib/jobsApi";

/** The training config Nori forwards to LeLab's /jobs/training (target is added here). */
export type NoriTrainingConfig = Omit<TrainingRequest, "target">;

export type CustomerProfile = components["schemas"]["CustomerProfile"];
export type PolicyListEntry = components["schemas"]["PolicyListEntry"];
export type Acquisition = components["schemas"]["AcquisitionResponse"];
/** Result of the LeLab download proxy — bytes cached to local disk. */
export interface PolicyDownloadResult {
  ref: string;
  path: string;
  size_bytes: number;
}
export type DispatchResponse = components["schemas"]["DispatchResponse"];
export type TrainingJob = components["schemas"]["TrainingJob"];
export type TrainingJobLogs = components["schemas"]["TrainingJobLogs"];
export type SessionRow = components["schemas"]["SessionRow"];
export type Consent = components["schemas"]["Consent"];
export type ConsentType = components["schemas"]["ConsentGrantRequest"]["consent_type"];
export type DeletionRequest = components["schemas"]["DeletionRequest"];
export type DeletionScope = components["schemas"]["DeletionRequestCreate"]["request_scope"];

/** Label for the consent-policy text the user agreed to. Bump when that text changes. */
export const CONSENT_POLICY_VERSION = "v1";
/** GET /customers/me returns the profile, or this shape when not yet provisioned. */
export type NotProvisioned = { provisioned: false } & Record<string, unknown>;
export type CustomerMe = CustomerProfile | NotProvisioned;

export function isProvisioned(me: CustomerMe): me is CustomerProfile {
  return (me as NotProvisioned).provisioned !== false && "id" in me;
}

export interface NoriPublicConfig {
  noriBackendUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  configured: boolean;
}

/** Build the fetcher that injects the Nori JWT header on top of the base fetcher. */
function withNoriAuth(fetcher: Fetcher): Fetcher {
  return async (url, options = {}) => {
    const token = await getAccessToken();
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    };
    if (token) headers["X-Nori-JWT"] = token;
    return fetcher(url, { ...options, headers });
  };
}

/**
 * Make an authenticated request to a LeLab `/nori/*` proxy route.
 * `baseUrl` is the LeLab server (from ApiContext), not Nori-Backend directly.
 */
export function noriRequest<T = unknown>(
  baseUrl: string,
  fetcher: Fetcher,
  path: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  return apiRequest<T>(baseUrl, withNoriAuth(fetcher), path, options);
}

/** Public config bootstrap — does not require auth. */
export function getNoriConfig(baseUrl: string, fetcher: Fetcher): Promise<NoriPublicConfig> {
  return apiRequest<NoriPublicConfig>(baseUrl, fetcher, "/nori/config", {
    action: "Load Nori config",
    // This is THE LeLab-reachability probe (leLabAvailable gates local-hardware pages
    // on it). On a hosted page a fetch to the default dead localhost:8000 can hang
    // indefinitely — the bootstrap never settles and pages that should show
    // "unavailable on the web" just spin. A local server answers in ms; 4s is generous.
    signal: AbortSignal.timeout(4000),
  });
}

/**
 * Build-time public config, used as a fallback when no LeLab server is reachable
 * (the LeLab-free hosted deploy — e.g. the standalone VR page). Populated from
 * `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (+ optional `VITE_NORI_BACKEND_URL`)
 * baked in at build time. Returns null when the bundle was built without them, so the
 * default LeLab-served `/nori/config` path is completely unaffected.
 *
 * These are PUBLIC values — the anon key already ships to every browser via
 * `/nori/config`; baking it is not a secrets leak. A service-role key must never go here.
 */
export function getBuildTimeConfig(): NoriPublicConfig | null {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) return null;
  return {
    noriBackendUrl: import.meta.env.VITE_NORI_BACKEND_URL ?? "",
    supabaseUrl,
    supabaseAnonKey,
    configured: true,
  };
}

// -- customers / provisioning (Phase 2) ----------------------------------------

/** POST /nori/customers/me/provision — idempotent; safe on every sign-in. */
export function provisionCustomer(baseUrl: string, fetcher: Fetcher): Promise<CustomerProfile> {
  return noriRequest<CustomerProfile>(baseUrl, fetcher, "/nori/customers/me/provision", {
    method: "POST",
    action: "Provision account",
  });
}

/** GET /nori/customers/me — profile, or NotProvisioned if not yet provisioned. */
export function getCustomer(baseUrl: string, fetcher: Fetcher): Promise<CustomerMe> {
  return noriRequest<CustomerMe>(baseUrl, fetcher, "/nori/customers/me", {
    action: "Load account",
  });
}

// -- marketplace (Phase 3) -----------------------------------------------------

/** GET /nori/marketplace/policies — full catalog; filter by `source` client-side. */
export function listPolicies(baseUrl: string, fetcher: Fetcher): Promise<PolicyListEntry[]> {
  return noriRequest<PolicyListEntry[]>(baseUrl, fetcher, "/nori/marketplace/policies", {
    action: "Load marketplace",
  });
}

/** POST /nori/marketplace/policies/{listingId}/acquire. */
export function acquirePolicy(
  baseUrl: string,
  fetcher: Fetcher,
  listingId: string
): Promise<Acquisition> {
  return noriRequest<Acquisition>(
    baseUrl,
    fetcher,
    `/nori/marketplace/policies/${encodeURIComponent(listingId)}/acquire`,
    { method: "POST", action: "Acquire policy" }
  );
}

/** POST /nori/marketplace/policies/{ref}/download — caches bytes to local disk. */
export function downloadPolicy(
  baseUrl: string,
  fetcher: Fetcher,
  ref: string
): Promise<PolicyDownloadResult> {
  return noriRequest<PolicyDownloadResult>(
    baseUrl,
    fetcher,
    `/nori/marketplace/policies/${encodeURIComponent(ref)}/download`,
    { method: "POST", action: "Download policy" }
  );
}

/** One file of a policy bundle, as reported by the details endpoint. */
export interface PolicyFileSummary {
  name: string;
  size_bytes: number | null;
  sha256: string | null;
}
/** Full detail view — superset of the catalog list entry. */
export interface PolicyDetails {
  ref: string;
  source: string;
  title: string;
  is_renamed: boolean;
  description: string | null;
  policy_class: string | null;
  price_usd: number | null;
  created_at: string;
  dataset_repo: string | null;
  promoted_at: string | null;
  final_cost_usd: number | null;
  timeout_seconds: number | null;
  editable: boolean;
  files: PolicyFileSummary[];
}

/** GET /nori/marketplace/policies/{ref}/details — full detail view. */
export function getPolicyDetails(
  baseUrl: string,
  fetcher: Fetcher,
  ref: string
): Promise<PolicyDetails> {
  return noriRequest<PolicyDetails>(
    baseUrl,
    fetcher,
    `/nori/marketplace/policies/${encodeURIComponent(ref)}/details`,
    { action: "Load policy details" }
  );
}

/** PATCH /nori/marketplace/policies/{ref} — rename an own policy (title=null clears). */
export function renamePolicy(
  baseUrl: string,
  fetcher: Fetcher,
  ref: string,
  title: string | null
): Promise<PolicyDetails> {
  return noriRequest<PolicyDetails>(
    baseUrl,
    fetcher,
    `/nori/marketplace/policies/${encodeURIComponent(ref)}`,
    { method: "PATCH", body: { title }, action: "Rename policy" }
  );
}

/** One installed policy in the local Nori cache. */
export interface LocalPolicy {
  ref: string;
  path: string;
  files: { name: string; size_bytes: number }[];
  size_bytes: number;
  runnable: boolean;
}

/** GET /nori/policies/local — installed policies (survives refresh; local disk). */
export function listLocalPolicies(
  baseUrl: string,
  fetcher: Fetcher
): Promise<LocalPolicy[]> {
  return noriRequest<LocalPolicy[]>(baseUrl, fetcher, "/nori/policies/local", {
    action: "Load installed policies",
  });
}

/** DELETE /nori/policies/local/{ref} — remove an installed policy from the cache. */
export function deleteLocalPolicy(
  baseUrl: string,
  fetcher: Fetcher,
  ref: string
): Promise<{ ref: string; deleted: boolean }> {
  return noriRequest<{ ref: string; deleted: boolean }>(
    baseUrl,
    fetcher,
    `/nori/policies/local/${encodeURIComponent(ref)}`,
    { method: "DELETE", action: "Remove installed policy" }
  );
}

// -- datasets / training (Phase 4) ---------------------------------------------

/** POST /nori/datasets/upload — runs the backend-mediated 4-step S3 upload. */
export function uploadDataset(
  baseUrl: string,
  fetcher: Fetcher,
  repoId: string,
  commitMessage?: string
): Promise<SessionRow> {
  return noriRequest<SessionRow>(baseUrl, fetcher, "/nori/datasets/upload", {
    method: "POST",
    body: { repo_id: repoId, commit_message: commitMessage },
    action: "Upload dataset",
  });
}

/** POST /nori/training/dispatch — body {timeout_seconds: 60..3600}. */
export function dispatchTraining(
  baseUrl: string,
  fetcher: Fetcher,
  timeoutSeconds = 900
): Promise<DispatchResponse> {
  return noriRequest<DispatchResponse>(baseUrl, fetcher, "/nori/training/dispatch", {
    method: "POST",
    body: { timeout_seconds: timeoutSeconds },
    action: "Dispatch training",
  });
}

/**
 * Start a Nori-dispatched training via LeLab's existing /jobs/training endpoint with a
 * `nori_cloud` target. The job lands in LeLab's job registry + watch UI (NoriCloudJobRunner)
 * AND, since it dispatches to the backend, in GET /nori/training/jobs. Returns the LeLab
 * JobRecord (its `id` keys the local monitor at /nori/training/:jobId).
 *
 * NOTE: the whole `config` (policy/steps/optimizer/…) is forwarded and recorded on the
 * LeLab JobRecord, but Nori-Backend's dispatch is currently config-less — it only reads
 * `target.timeout_seconds` and decides what to train from the customer's data + consents.
 * The extra fields have no training effect until Nori-Backend honors them.
 */
export function startNoriTraining(
  baseUrl: string,
  fetcher: Fetcher,
  config: NoriTrainingConfig,
  timeoutSeconds = 900
): Promise<JobRecord> {
  return noriRequest<JobRecord>(baseUrl, fetcher, "/jobs/training", {
    method: "POST",
    body: {
      config,
      target: { runner: "nori_cloud", timeout_seconds: timeoutSeconds },
    },
    action: "Start training",
  });
}

export function listJobs(baseUrl: string, fetcher: Fetcher): Promise<TrainingJob[]> {
  return noriRequest<TrainingJob[]>(baseUrl, fetcher, "/nori/training/jobs", {
    action: "Load training jobs",
  });
}

export function getJob(baseUrl: string, fetcher: Fetcher, jobId: string): Promise<TrainingJob> {
  return noriRequest<TrainingJob>(
    baseUrl,
    fetcher,
    `/nori/training/jobs/${encodeURIComponent(jobId)}`,
    { action: "Load training job" }
  );
}

/** GET /nori/training/jobs/{id}/logs?since= — poll ~2s; stop when is_terminal. */
export function getJobLogs(
  baseUrl: string,
  fetcher: Fetcher,
  jobId: string,
  since = 0
): Promise<TrainingJobLogs> {
  return noriRequest<TrainingJobLogs>(
    baseUrl,
    fetcher,
    `/nori/training/jobs/${encodeURIComponent(jobId)}/logs?since=${since}`,
    { action: "Load training logs" }
  );
}

// -- pairing / consents / deletion (Phase 6) -----------------------------------

/** POST /nori/customers/me/pair — pair a robot (multi-robot). First robot becomes
 * active; later ones are added inactive. Idempotent on a serial you already own;
 * 409 only if the serial is owned by another customer. Returns the updated profile. */
export function pairRobot(
  baseUrl: string,
  fetcher: Fetcher,
  robotSerialNumber: string
): Promise<CustomerProfile> {
  return noriRequest<CustomerProfile>(baseUrl, fetcher, "/nori/customers/me/pair", {
    method: "POST",
    body: { robot_serial_number: robotSerialNumber },
    action: "Pair robot",
  });
}

/**
 * One robot paired to the customer, as returned by `GET /customers/me/robots`
 * (multi-robot; live in Nori-Backend as of 2026-07-06). The Pairing page still
 * keeps a profile-derived single-robot fallback for resilience if that call fails.
 */
export interface PairedRobot {
  robot_serial_number: string;
  nickname?: string | null;
  paired_at?: string | null;
  /** True for the robot teleop/remote currently targets. */
  is_active?: boolean;
}

/** GET /nori/customers/me/robots — all robots paired to the customer (multi-robot). */
export function listRobots(baseUrl: string, fetcher: Fetcher): Promise<PairedRobot[]> {
  return noriRequest<PairedRobot[]>(baseUrl, fetcher, "/nori/customers/me/robots", {
    action: "Load robots",
  });
}

/**
 * POST /nori/customers/me/unpair — detach a robot. Pass the serial to unpair a specific
 * robot (multi-robot); omit to unpair the sole/active robot. Idempotent if already gone.
 */
export function unpairRobot(
  baseUrl: string,
  fetcher: Fetcher,
  robotSerialNumber?: string
): Promise<CustomerProfile> {
  return noriRequest<CustomerProfile>(baseUrl, fetcher, "/nori/customers/me/unpair", {
    method: "POST",
    body: robotSerialNumber ? { robot_serial_number: robotSerialNumber } : undefined,
    action: "Unpair robot",
  });
}

/**
 * POST /nori/customers/me/robots/{serial}/select — set which paired robot is active
 * (the one teleop/remote connects to). Returns the updated profile.
 */
export function selectRobot(
  baseUrl: string,
  fetcher: Fetcher,
  robotSerialNumber: string
): Promise<CustomerProfile> {
  return noriRequest<CustomerProfile>(
    baseUrl,
    fetcher,
    `/nori/customers/me/robots/${encodeURIComponent(robotSerialNumber)}/select`,
    { method: "POST", action: "Select robot" }
  );
}

export function listConsents(baseUrl: string, fetcher: Fetcher): Promise<Consent[]> {
  return noriRequest<Consent[]>(baseUrl, fetcher, "/nori/consents", {
    action: "Load consents",
  });
}

export function grantConsent(
  baseUrl: string,
  fetcher: Fetcher,
  consentType: ConsentType
): Promise<Consent> {
  return noriRequest<Consent>(baseUrl, fetcher, "/nori/consents", {
    method: "POST",
    body: { consent_type: consentType, policy_version: CONSENT_POLICY_VERSION },
    action: "Grant consent",
  });
}

export function revokeConsent(
  baseUrl: string,
  fetcher: Fetcher,
  consentId: string,
  reason?: string
): Promise<Consent> {
  return noriRequest<Consent>(
    baseUrl,
    fetcher,
    `/nori/consents/${encodeURIComponent(consentId)}/revoke`,
    { method: "POST", body: { reason }, action: "Revoke consent" }
  );
}

export function createDeletionRequest(
  baseUrl: string,
  fetcher: Fetcher,
  requestScope: DeletionScope,
  notes?: string
): Promise<DeletionRequest> {
  return noriRequest<DeletionRequest>(baseUrl, fetcher, "/nori/deletion-requests", {
    method: "POST",
    body: { request_scope: requestScope, notes },
    action: "Request deletion",
  });
}
