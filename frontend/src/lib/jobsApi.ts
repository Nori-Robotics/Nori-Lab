export type JobState = "running" | "done" | "failed" | "interrupted";

export interface TrainingMetrics {
  current_step: number;
  total_steps: number;
  current_loss: number | null;
  current_lr: number | null;
  grad_norm: number | null;
  eta_seconds: number | null;
}

export interface LogLine {
  timestamp: number;
  message: string;
}

// Mirror of the backend TrainingRequest. The frontend doesn't send all of
// these; defaults on the server fill in the rest.
export interface TrainingRequest {
  dataset_repo_id: string;
  policy_type: string;
  steps: number;
  batch_size: number;
  seed?: number;
  num_workers: number;
  log_freq: number;
  save_freq: number;
  save_checkpoint: boolean;
  resume: boolean;
  wandb_enable: boolean;
  wandb_project?: string;
  wandb_entity?: string;
  wandb_notes?: string;
  wandb_mode?: string;
  wandb_disable_artifact: boolean;
  policy_device?: string;
  policy_use_amp: boolean;
  optimizer_type?: string;
  optimizer_lr?: number;
  optimizer_weight_decay?: number;
  optimizer_grad_clip_norm?: number;
  use_policy_training_preset: boolean;
  // Optional target for runner dispatch; omitted ⇒ local.
  target?: { runner: "local" | "hf_cloud"; flavor?: string };
}

export interface JobRecord {
  id: string;
  name: string;
  state: JobState;
  config: TrainingRequest;
  output_dir: string;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  error_message: string | null;
  metrics: TrainingMetrics;
  runner: "local" | "hf_cloud";
  hf_job_id: string | null;
  hf_flavor: string | null;
  hf_repo_id: string | null;
  hf_job_url: string | null;
}

type Fetcher = (url: string, options?: RequestInit) => Promise<Response>;

async function expectOk(r: Response, action: string): Promise<Response> {
  if (!r.ok) {
    let detail = `${r.status}`;
    try {
      const body = await r.json();
      detail = body.detail || detail;
    } catch {
      // ignore
    }
    throw new Error(`${action} failed: ${detail}`);
  }
  return r;
}

export async function listJobs(
  baseUrl: string,
  fetcher: Fetcher,
  limit = 10,
): Promise<JobRecord[]> {
  const r = await fetcher(`${baseUrl}/jobs?limit=${limit}`);
  await expectOk(r, "List jobs");
  const body = await r.json();
  return body.jobs;
}

export async function getJob(
  baseUrl: string,
  fetcher: Fetcher,
  id: string,
): Promise<JobRecord> {
  const r = await fetcher(`${baseUrl}/jobs/${id}`);
  await expectOk(r, "Get job");
  return r.json();
}

export async function getJobLogs(
  baseUrl: string,
  fetcher: Fetcher,
  id: string,
): Promise<LogLine[]> {
  const r = await fetcher(`${baseUrl}/jobs/${id}/logs`);
  await expectOk(r, "Get job logs");
  const body = await r.json();
  return body.logs;
}

export async function getJobLogFile(
  baseUrl: string,
  fetcher: Fetcher,
  id: string,
): Promise<LogLine[]> {
  const r = await fetcher(`${baseUrl}/jobs/${id}/log-file`);
  await expectOk(r, "Get job log file");
  const body = await r.json();
  return body.logs;
}

export async function startTrainingJob(
  baseUrl: string,
  fetcher: Fetcher,
  request: TrainingRequest,
): Promise<JobRecord> {
  const { target, ...config } = request;
  const body = target ? { config, target } : config;
  const r = await fetcher(`${baseUrl}/jobs/training`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 409) {
    throw new Error("Another training is already running. Stop it first.");
  }
  await expectOk(r, "Start training");
  return r.json();
}

export async function stopJob(
  baseUrl: string,
  fetcher: Fetcher,
  id: string,
): Promise<JobRecord> {
  const r = await fetcher(`${baseUrl}/jobs/${id}/stop`, { method: "POST" });
  await expectOk(r, "Stop job");
  return r.json();
}

export async function deleteJob(
  baseUrl: string,
  fetcher: Fetcher,
  id: string,
): Promise<void> {
  const r = await fetcher(`${baseUrl}/jobs/${id}`, { method: "DELETE" });
  await expectOk(r, "Delete job");
}

export interface RunnerFlavor {
  name: string;
  pretty_name: string;
  cpu: string;
  ram: string;
  accelerator: string | null;
  unit_cost_usd: number;
  unit_label: string;
}

export interface RunnerHardwareResponse {
  authenticated: boolean;
  username: string | null;
  flavors: RunnerFlavor[];
}

export async function listRunnerHardware(
  baseUrl: string,
  fetcher: Fetcher,
): Promise<RunnerHardwareResponse> {
  const r = await fetcher(`${baseUrl}/jobs/runners/hardware`);
  if (!r.ok) {
    return { authenticated: false, username: null, flavors: [] };
  }
  return r.json();
}

export interface HubJob {
  id: string;
  created_at: string | null;
  docker_image: string | null;
  space_id: string | null;
  flavor: string | null;
  status: { stage: string; message: string | null } | null;
  owner: string | null;
  url: string;
}

export interface HubModel {
  repo_id: string;
  last_modified: string | null;
  private: boolean;
}

export interface HubJobsResponse {
  authenticated: boolean;
  jobs: HubJob[];
  models: HubModel[];
}

export async function listHubJobs(
  baseUrl: string,
  fetcher: Fetcher,
): Promise<HubJobsResponse> {
  const r = await fetcher(`${baseUrl}/jobs/hub`);
  if (!r.ok) {
    return { authenticated: false, jobs: [], models: [] };
  }
  return r.json();
}
