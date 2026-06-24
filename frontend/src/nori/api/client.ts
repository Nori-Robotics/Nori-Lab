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
  });
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
