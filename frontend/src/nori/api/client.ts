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
/** upload_dataset adds this when it skipped the transfer because an identical
 *  promoted upload already exists (idempotent upload). */
export type MaybeDeduplicated = { deduplicated?: boolean };
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

// -- hosted direct-backend mode --------------------------------------------
// On the hosted site (Vercel) there is no local LeLab, so the `/nori/*` proxy
// has nowhere to go. The pure-proxy routes are 1:1 mirrors of Nori-Backend's
// `/api/v1/*` surface and the backend validates the Supabase JWT itself, so in
// hosted mode we call the backend directly: `/nori/X` → `<backend>/api/v1/X`
// with `Authorization: Bearer <jwt>` (instead of the X-Nori-JWT proxy header).
// Enabled by NoriContext when the bootstrap falls back to build-time config
// AND the bundle carries VITE_NORI_BACKEND_URL. Requires the backend to
// allowlist this origin (Nori-Backend config.py `_HOSTED_APP_ORIGINS`).
let directBackendUrl: string | null = null;

/** LeLab-local surfaces with no backend equivalent (hardware, local disk,
 * the local LLM proxy, the installed-policy cache). Blocked with a clear
 * error instead of a confusing 404. */
const LELAB_ONLY_PREFIXES = [
  "/nori/llm",
  "/nori/leader",
  "/nori/datasets/upload",
  "/nori/policies/local",
];

// Routing gate: pages fetch on mount, but proxy-vs-direct is only decided when
// the bootstrap's config probe settles (up to 4s later on a hosted page). Every
// noriRequest waits on this gate so a mount-time fetch can't race ahead and hit
// the dead localhost proxy before direct mode is enabled. Mirrors the Supabase
// auth gate in auth/supabase.ts. NoriContext MUST settle it on every bootstrap
// terminal path (success, fallback, and error) or all /nori/* requests hang.
let settleRouting: (() => void) | undefined;
const routingSettled = new Promise<void>((resolve) => {
  settleRouting = resolve;
});

/** Called by NoriContext once proxy-vs-direct routing is decided. Idempotent. */
export function settleBackendRouting(): void {
  settleRouting?.();
}

export function enableDirectBackend(url: string): void {
  directBackendUrl = url.replace(/\/+$/, "");
}

/** True when requests go straight to Nori-Backend (hosted, LeLab-free). */
export function isDirectBackend(): boolean {
  return directBackendUrl !== null;
}

function withDirectAuth(fetcher: Fetcher): Fetcher {
  return async (url, options = {}) => {
    const token = await getAccessToken();
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return fetcher(url, { ...options, headers });
  };
}

/**
 * Make an authenticated request to a LeLab `/nori/*` proxy route — or, in
 * hosted direct-backend mode, to the equivalent Nori-Backend route.
 * `baseUrl` is the LeLab server (from ApiContext), not Nori-Backend directly.
 */
export async function noriRequest<T = unknown>(
  baseUrl: string,
  fetcher: Fetcher,
  path: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  await routingSettled; // proxy-vs-direct decided by the bootstrap — see gate above
  if (directBackendUrl) {
    if (
      LELAB_ONLY_PREFIXES.some((p) => path.startsWith(p)) ||
      path.endsWith("/download") // marketplace install writes to LeLab's local disk
    ) {
      throw new Error(
        "This action needs the Nori desktop app — it isn't available on the hosted site."
      );
    }
    const apiPath = path.replace(/^\/nori/, "/api/v1");
    return apiRequest<T>(directBackendUrl, withDirectAuth(fetcher), apiPath, options);
  }
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
/** LeRobot stats for a dataset listing (from meta/info.json); datasets only. */
export interface DatasetStats {
  total_episodes: number | null;
  total_frames: number | null;
  fps: number | null;
  robot_type: string | null;
  task: string | null;
}
/** Full detail view — superset of the catalog list entry. */
export interface PolicyDetails {
  ref: string;
  source: string;
  kind?: string; // "policy" | "dataset" | "bundle"
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
  dataset_stats?: DatasetStats | null;
  /** Real training stats for own policies (null for listings). */
  training_steps?: number | null;
  batch_size?: number | null;
  dataset_episode_count?: number | null;
  dataset_frame_count?: number | null;
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
    `/nori/marketplace/policies/${encodeURIComponent(ref)}`,
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

/**
 * One of the caller's community-publish submissions (any lifecycle state).
 * `status`: pending_review | public | rejected | taken_down. Non-public states
 * are visible ONLY to the owner (this view); the public catalog never shows them.
 */
export interface MyListing {
  listing_id: string;
  source_job_id: string | null;
  title: string;
  description: string | null;
  status: string;
  review_reason: string | null;
  in_review: boolean;
  is_public: boolean;
  created_at: string;
}


/**
 * POST .../publish — request community publication of an OWN policy. Creates a
 * pending_review listing; re-homing + human review happen server-side before it
 * goes public. 403 = grant the publish_public consent first; 409 = already has
 * an active listing / in-flight deletion / pre-bundle legacy policy.
 */
export function publishPolicy(
  baseUrl: string,
  fetcher: Fetcher,
  ref: string,
  title: string,
  description: string | null
): Promise<MyListing> {
  return noriRequest<MyListing>(
    baseUrl,
    fetcher,
    `/nori/marketplace/policies/${encodeURIComponent(ref)}/publish`,
    { method: "POST", body: { title, description }, action: "Publish policy" }
  );
}

/** POST /nori/marketplace/datasets/{uploadRef}/publish — publish one of your
 * PROMOTED uploads as a community dataset (uploadRef = the upload session id).
 * 202: created in pending_review, auto-publishes after re-homing + the format
 * gate. 403 without publish_public consent; 409 if already published. */
export function publishDataset(
  baseUrl: string,
  fetcher: Fetcher,
  uploadRef: string,
  title: string,
  description: string | null
): Promise<MyListing> {
  return noriRequest<MyListing>(
    baseUrl,
    fetcher,
    `/nori/marketplace/datasets/${encodeURIComponent(uploadRef)}/publish`,
    { method: "POST", body: { title, description }, action: "Publish dataset" }
  );
}

/** DELETE .../publish — instant, idempotent takedown of the active listing. */
export function unpublishPolicy(
  baseUrl: string,
  fetcher: Fetcher,
  ref: string
): Promise<{ taken_down: string[] }> {
  return noriRequest<{ taken_down: string[] }>(
    baseUrl,
    fetcher,
    `/nori/marketplace/policies/${encodeURIComponent(ref)}/publish`,
    { method: "DELETE", action: "Unpublish policy" }
  );
}

/** GET /nori/marketplace/my-listings — the caller's submissions + review state. */
export function listMyListings(baseUrl: string, fetcher: Fetcher): Promise<MyListing[]> {
  return noriRequest<MyListing[]>(baseUrl, fetcher, "/nori/marketplace/my-listings", {
    action: "Load my listings",
  });
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
/** Constants for client-side training-time estimates — same numbers the
 * backend's dispatch fit-gate uses, so UI estimate and server verdict can
 * never disagree. `resumable` flips server-side when safe pause/resume ships. */
export interface TrainingEstimateParams {
  step_rates: Record<string, { floor: number; typical: number }>;
  setup_seconds: number;
  max_timeout_seconds: number;
  resumable: boolean;
}

/** One policy in the My Stuff library, with its UI state bucket and lineage. */
export interface LibraryPolicy {
  job_id: string;
  /** The customer's display title (set via rename), if any. */
  title: string | null;
  /** applied_config.policy_type — available pre-promotion (policy_class isn't). */
  policy_type: string | null;
  /** First RUNNING sighting; drives the live-progress estimate. */
  run_started_at: string | null;
  status: string;
  state: "live" | "training" | "paused" | "failed";
  policy_class: string | null;
  steps: number | null;
  steps_done: number | null;
  created_at: string;
  promoted_at: string | null;
  checkpoint_url: string | null;
  final_cost_usd: number | null;
  /** Owner-set: when true, the policy can't be renamed or deleted. */
  locked?: boolean;
}

/** One uploaded dataset with the policies trained from it. */
export interface LibraryDataset {
  dataset_ref: string;
  session_id: string;
  label: string;
  created_at: string;
  episode_count: number | null;
  frame_count: number | null;
  /** Owner-set: when true, the dataset can't be renamed or deleted. */
  locked?: boolean;
  policies: LibraryPolicy[];
}

export interface Library {
  datasets: LibraryDataset[];
  /** Policies whose source dataset can't be resolved (shown as "source not recorded"). */
  unlinked_policies: LibraryPolicy[];
}

/** PATCH /nori/datasets/upload/{id} — rename an upload (owner-private label). */
export function renameUploadLabel(
  baseUrl: string,
  fetcher: Fetcher,
  sessionId: string,
  label: string
): Promise<SessionRow> {
  return noriRequest<SessionRow>(
    baseUrl,
    fetcher,
    `/nori/datasets/upload/${encodeURIComponent(sessionId)}`,
    { method: "PATCH", body: { label }, action: "Rename dataset" }
  );
}

/** PATCH /nori/training/jobs/{id}/name — name a policy at ANY lifecycle stage
 * (before training finishes included). None/empty clears back to generated titles. */
export function renameTrainingJob(
  baseUrl: string,
  fetcher: Fetcher,
  jobId: string,
  title: string | null
): Promise<{ job_id: string; title: string | null }> {
  return noriRequest<{ job_id: string; title: string | null }>(
    baseUrl,
    fetcher,
    `/nori/training/jobs/${encodeURIComponent(jobId)}/name`,
    { method: "PATCH", body: { title }, action: "Rename policy" }
  );
}

/** GET /nori/library — the My Stuff aggregate (datasets ↔ policies, joined by lineage). */
export function getLibrary(baseUrl: string, fetcher: Fetcher): Promise<Library> {
  return noriRequest<Library>(baseUrl, fetcher, "/nori/library", { action: "Load your library" });
}

/** One robot-recorded episode bundle (W2.11). Not trainable yet (needs assembly);
 *  a read-only view of what the robot has recorded and where it is in its journey
 *  to the cloud. `status`: PROMOTED = in your cloud; PENDING_UPLOAD/FINALIZING =
 *  in flight; FAILED/PROMOTION_FAILED = needs attention. */
export interface RawBundleEntry {
  session_id: string;
  label: string;
  status: string;
  hf_path_prefix: string | null;
  episode_count: number | null;
  frame_count: number | null;
  created_at: string;
  finalized_at: string | null;
  failure_reason: string | null;
  /** True while this recording is a source of an in-flight assembly job — the UI
   *  shows "Uploading to dataset" and it can't be selected again meanwhile. */
  assembling?: boolean;
}

export interface RobotRecordings {
  bundles: RawBundleEntry[];
  /** Episodes recorded but not yet uploaded from the robot; null if unknown
   *  (the robot hasn't reported recently / heartbeat table unavailable). */
  on_robot_pending: number | null;
}

/** GET /nori/datasets/raw-bundles — the caller's robot recordings for My Stuff. */
export function getRobotRecordings(baseUrl: string, fetcher: Fetcher): Promise<RobotRecordings> {
  return noriRequest<RobotRecordings>(baseUrl, fetcher, "/nori/datasets/raw-bundles", {
    action: "Load your robot recordings",
  });
}

/** An assembly job (recording -> flat LeRobot dataset). Enqueued by /assemble and
 *  the session/episode delete rebuilds; poll getAssemblyJob until terminal. */
export interface AssemblyJob {
  id: string;
  status: "PENDING" | "ASSEMBLING" | "DONE" | "FAILED";
  mode: "new" | "append" | "rebuild";
  failure_reason: string | null;
  result_dataset_session_id: string | null;
  created_at: string;
}

/** POST /nori/datasets/assemble — turn robot recordings into a trainable dataset
 *  (a NEW one, or APPEND onto an existing dataset). Returns the job to poll. */
export function assembleDataset(
  baseUrl: string,
  fetcher: Fetcher,
  args: { sources: string[]; mode: "new" | "append"; targetDatasetSessionId?: string | null; name?: string | null }
): Promise<{ assembly_job_id: string; status: string }> {
  return noriRequest(baseUrl, fetcher, "/nori/datasets/assemble", {
    method: "POST",
    body: {
      sources: args.sources,
      mode: args.mode,
      target_dataset_session_id: args.targetDatasetSessionId ?? null,
      name: args.name ?? null,
    },
    action: "Assemble dataset",
  });
}

/** GET /nori/datasets/assemble/{id} — poll one assembly job. */
export function getAssemblyJob(baseUrl: string, fetcher: Fetcher, jobId: string): Promise<AssemblyJob> {
  return noriRequest<AssemblyJob>(baseUrl, fetcher, `/nori/datasets/assemble/${encodeURIComponent(jobId)}`, {
    action: "Check assembly status",
  });
}

/** One recording session that contributed episodes to an assembled dataset —
 *  the unit you can filter by or bulk-delete. */
export interface DatasetProvenanceSession {
  session_key: string;
  recorded_at: string | null;
  task: string | null;
  episode_count: number;
  source_raw_session_id: string | null;
  created_at: string;
}

/** GET /nori/datasets/{id}/sessions — provenance sessions of an assembled dataset. */
export function getDatasetSessions(
  baseUrl: string,
  fetcher: Fetcher,
  datasetSessionId: string
): Promise<{ sessions: DatasetProvenanceSession[] }> {
  return noriRequest(baseUrl, fetcher, `/nori/datasets/${encodeURIComponent(datasetSessionId)}/sessions`, {
    action: "Load dataset sessions",
  });
}

/** DELETE /nori/datasets/{id}/sessions/{key} — bulk-delete a whole session's
 *  episodes. Enqueues a reindex-safe rebuild; returns the job to poll. */
export function deleteDatasetSession(
  baseUrl: string,
  fetcher: Fetcher,
  datasetSessionId: string,
  sessionKey: string
): Promise<{ assembly_job_id: string; status: string }> {
  return noriRequest(
    baseUrl,
    fetcher,
    `/nori/datasets/${encodeURIComponent(datasetSessionId)}/sessions/${encodeURIComponent(sessionKey)}`,
    { method: "DELETE", action: "Delete session" }
  );
}

/** POST /nori/datasets/{id}/delete-episodes — delete individual episodes by index.
 *  Enqueues a reindex-safe rebuild; returns the job to poll. */
export function deleteDatasetEpisodes(
  baseUrl: string,
  fetcher: Fetcher,
  datasetSessionId: string,
  episodeIndices: number[]
): Promise<{ assembly_job_id: string; status: string }> {
  return noriRequest(
    baseUrl,
    fetcher,
    `/nori/datasets/${encodeURIComponent(datasetSessionId)}/delete-episodes`,
    { method: "POST", body: { episode_indices: episodeIndices }, action: "Delete episodes" }
  );
}

/** DELETE /nori/datasets/{id} — permanently delete a dataset (HF files + record).
 * Owner-scoped; 409 if the dataset is published to the community. */
export function deleteDataset(
  baseUrl: string,
  fetcher: Fetcher,
  sessionId: string
): Promise<{ deleted: boolean; session_id: string }> {
  return noriRequest(baseUrl, fetcher, `/nori/datasets/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    action: "Delete dataset",
  });
}

/** POST /nori/datasets/{id}/lock — lock/unlock a dataset (locked = no rename/delete). */
export function setDatasetLock(
  baseUrl: string,
  fetcher: Fetcher,
  sessionId: string,
  locked: boolean
): Promise<{ session_id: string; locked: boolean }> {
  return noriRequest(baseUrl, fetcher, `/nori/datasets/${encodeURIComponent(sessionId)}/lock`, {
    method: "POST",
    body: { locked },
    action: locked ? "Lock dataset" : "Unlock dataset",
  });
}

/** DELETE /nori/library/policies/{id} — delete a policy (checkpoint + record).
 * 409 if the policy is published, still training, or locked. */
export function deletePolicy(
  baseUrl: string,
  fetcher: Fetcher,
  jobId: string
): Promise<{ deleted: boolean; job_id: string }> {
  return noriRequest(baseUrl, fetcher, `/nori/library/policies/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
    action: "Delete policy",
  });
}

/** POST /nori/library/policies/{id}/lock — lock/unlock a policy. */
export function setPolicyLock(
  baseUrl: string,
  fetcher: Fetcher,
  jobId: string,
  locked: boolean
): Promise<{ job_id: string; locked: boolean }> {
  return noriRequest(baseUrl, fetcher, `/nori/library/policies/${encodeURIComponent(jobId)}/lock`, {
    method: "POST",
    body: { locked },
    action: locked ? "Lock policy" : "Unlock policy",
  });
}

export function getTrainingEstimateParams(
  baseUrl: string,
  fetcher: Fetcher
): Promise<TrainingEstimateParams> {
  return noriRequest<TrainingEstimateParams>(baseUrl, fetcher, "/nori/training/estimate-params", {
    action: "Load training estimate params",
  });
}

/** Safe pause of a running training job — the trainer checkpoints and the
 * job lands PAUSED (resumable) within ~a minute. 409 if already terminal. */
export function stopTrainingJob(
  baseUrl: string,
  fetcher: Fetcher,
  jobId: string
): Promise<{ stopping: boolean; detail: string }> {
  return noriRequest(baseUrl, fetcher, `/nori/training/jobs/${encodeURIComponent(jobId)}/stop`, {
    method: "POST",
    action: "Pause training",
  });
}

/** Resume a PAUSED job from its checkpoint. Config + dataset come from the
 * paused job; timeoutSeconds reserves the fresh segment's usage — a 402 here
 * means the monthly allowance can't cover it (surface it as an alert). */
export function resumeTrainingJob(
  baseUrl: string,
  fetcher: Fetcher,
  jobId: string,
  timeoutSeconds = 900,
  /** New TOTAL step target — only for CONTINUING a COMPLETED policy (must exceed
   *  what it already trained). Omit to just finish a PAUSED job's original target. */
  steps?: number
): Promise<DispatchResponse> {
  return noriRequest<DispatchResponse>(baseUrl, fetcher, "/nori/training/dispatch", {
    method: "POST",
    body: {
      resume_from_job_id: jobId,
      timeout_seconds: timeoutSeconds,
      ...(steps !== undefined ? { steps } : {}),
    },
    action: steps !== undefined ? "Continue training" : "Resume training",
  });
}

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

/** Cameras + arms recorded in a dataset — populates the scope picker so it only
 *  offers what was actually recorded. `datasetRef` omitted => the latest upload. */
export interface DatasetScopeOptions {
  cameras: string[];
  arms: string[];
  joints: string[];
}
export function getDatasetScopeOptions(
  baseUrl: string,
  fetcher: Fetcher,
  datasetRef?: string
): Promise<DatasetScopeOptions> {
  const q = datasetRef ? `?dataset_ref=${encodeURIComponent(datasetRef)}` : "";
  return noriRequest<DatasetScopeOptions>(
    baseUrl,
    fetcher,
    `/nori/training/dataset-features${q}`,
    { action: "Load dataset scope options" }
  );
}

/** One of Nori's published open datasets (GET /nori/marketplace/datasets/public). */
export interface PublicDataset {
  id: string;
  title: string;
  description: string | null;
  hf_repo: string;
  license: string | null;
}

export function listPublicDatasets(baseUrl: string, fetcher: Fetcher): Promise<PublicDataset[]> {
  return noriRequest<PublicDataset[]>(baseUrl, fetcher, "/nori/marketplace/datasets/public", {
    action: "Load open datasets",
  });
}

/** One of the customer's promoted datasets (training dataset_ref picker).
 * `source` is "upload" for the customer's own promoted uploads, or "community"
 * for a dataset acquired from the marketplace (dataset_ref = "community:<id>"). */
export interface MyDataset {
  dataset_ref: string;
  label: string;
  created_at: string;
  session_id: string;
  source?: string;
  /** Summary shown under the training dataset picker. Null for community
   * datasets and for uploads promoted before count capture landed. */
  episode_count?: number | null;
  frame_count?: number | null;
}

/** GET /nori/datasets/mine — the caller's promoted datasets, newest first. */
export function listMyDatasets(baseUrl: string, fetcher: Fetcher): Promise<MyDataset[]> {
  return noriRequest<MyDataset[]>(baseUrl, fetcher, "/nori/datasets/mine", {
    action: "Load datasets",
  });
}

/** Short-lived coturn TURN credentials, minted per session (backend §2.4). Drop
 * straight into RTCPeerConnection.iceServers; re-fetch after `ttl` seconds. */
export interface TurnCredentials {
  urls: string[];
  username: string;
  credential: string;
  ttl: number;
}

/** GET /nori/turn/credentials — mint short-lived coturn creds for this session.
 * Direct-backend mode maps to /api/v1/turn/credentials. Requires auth. */
export function getTurnCredentials(baseUrl: string, fetcher: Fetcher): Promise<TurnCredentials> {
  return noriRequest<TurnCredentials>(baseUrl, fetcher, "/nori/turn/credentials", {
    action: "Fetch TURN credentials",
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

/** GET /nori/training/jobs/{id}/logs?since= — poll ~2s; stop when is_terminal.
 * `tail` (only honored on a fresh read, since=0) returns just the last N lines
 * but reports the true end as next_offset, so a reload seeds cheaply and then
 * streams only new lines. Omit tail (or pass since>0) for the full log. */
export function getJobLogs(
  baseUrl: string,
  fetcher: Fetcher,
  jobId: string,
  since = 0,
  tail?: number
): Promise<TrainingJobLogs> {
  const q = `since=${since}${tail != null ? `&tail=${tail}` : ""}`;
  return noriRequest<TrainingJobLogs>(
    baseUrl,
    fetcher,
    `/nori/training/jobs/${encodeURIComponent(jobId)}/logs?${q}`,
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

/**
 * Billing summary (backend Phase 1 — prepaid tiers: free / pro $20/mo / developer).
 * Monthly fields are null until backend migration 013 is applied; the Account page
 * falls back to profile-derived numbers when this endpoint is unavailable.
 */
export interface BillingSummary {
  billing_tier: string;
  /** 0 for free, 20 for pro, null for developer (negotiated). */
  tier_price_usd_per_month: number | null;
  compute: {
    allowed_seconds_per_month: number;
    consumed_seconds_this_month: number;
    reserved_seconds_this_month: number;
    remaining_seconds_this_month: number;
  };
  agent_tokens: {
    used_today: number;
    allowed_today: number;
    soft_warn_threshold: number;
    used_this_month: number | null;
    allowed_per_month: number | null;
    hard_capped: boolean;
  };
  /** Route-level clamps for this tier; null = none (pro/developer today). */
  limits: {
    max_job_timeout_seconds: number;
    max_concurrent_jobs: number;
    max_robots: number;
  } | null;
}

/** GET /nori/billing/summary — tier + monthly compute + agent-token budgets. */
export function getBillingSummary(baseUrl: string, fetcher: Fetcher): Promise<BillingSummary> {
  return noriRequest<BillingSummary>(baseUrl, fetcher, "/nori/billing/summary", {
    action: "Load billing summary",
  });
}
