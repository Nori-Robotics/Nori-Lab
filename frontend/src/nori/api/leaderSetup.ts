import { apiRequest, type Fetcher } from "@/lib/apiClient";

export type LeaderSide = "left" | "right";
export type LeaderAutoSide = LeaderSide | "both";

export interface LeaderPortProbe {
  open_path: string;
  identity: Record<string, unknown>;
  expected_hits: number[];
  left_hits: number[];
  right_hits: number[];
  all_hits: number[];
  can_left: boolean;
  can_right: boolean;
}

export interface LeaderPortsResponse {
  success: boolean;
  message?: string;
  probes?: LeaderPortProbe[];
  ports?: Record<LeaderSide, Record<string, unknown>>;
}

export interface ManualStatus {
  active: boolean;
  session: {
    id: string;
    side: LeaderSide;
    calibration_id: string;
    center: Record<string, number>;
    mins: Record<string, number>;
    maxes: Record<string, number>;
    active: boolean;
  } | null;
}

export interface AutoStatus {
  active: boolean;
  status: string;
  side: LeaderAutoSide | null;
  calibration_id: string;
  message: string;
  error: string | null;
  result: unknown | null;
}

export interface LeaderLiveMotor {
  id: number;
  raw: number | null;
  target: number | null;
  ok: boolean;
}

export interface LeaderLiveSide {
  visible: number;
  motors: Record<string, LeaderLiveMotor>;
}

export interface LeaderLiveResponse {
  success: boolean;
  port: string;
  leaders: Record<LeaderSide, LeaderLiveSide>;
  updated_at: number;
}

export function autoSaveLeaderPorts(baseUrl: string, fetcher: Fetcher): Promise<LeaderPortsResponse> {
  return apiRequest<LeaderPortsResponse>(baseUrl, fetcher, "/nori/leader/ports/auto-save", {
    method: "POST",
    action: "Auto-save leader ports",
  });
}

export function saveLeaderPorts(
  baseUrl: string,
  fetcher: Fetcher,
  leftPort: string,
  rightPort?: string
): Promise<LeaderPortsResponse> {
  return apiRequest<LeaderPortsResponse>(baseUrl, fetcher, "/nori/leader/ports", {
    method: "POST",
    body: { left_port: leftPort, right_port: rightPort || null },
    action: "Save leader ports",
  });
}

export function manualStart(
  baseUrl: string,
  fetcher: Fetcher,
  side: LeaderSide,
  calibrationId: string,
  port?: string
): Promise<unknown> {
  return apiRequest(baseUrl, fetcher, "/nori/leader/manual/start", {
    method: "POST",
    body: { side, calibration_id: calibrationId, port: port || null },
    action: "Start manual calibration",
  });
}

export function manualCaptureCenter(baseUrl: string, fetcher: Fetcher): Promise<unknown> {
  return apiRequest(baseUrl, fetcher, "/nori/leader/manual/capture-center", {
    method: "POST",
    action: "Capture center",
  });
}

export function manualSample(baseUrl: string, fetcher: Fetcher): Promise<unknown> {
  return apiRequest(baseUrl, fetcher, "/nori/leader/manual/sample", {
    method: "POST",
    action: "Sample ranges",
  });
}

export function manualFinish(baseUrl: string, fetcher: Fetcher): Promise<unknown> {
  return apiRequest(baseUrl, fetcher, "/nori/leader/manual/finish", {
    method: "POST",
    action: "Finish manual calibration",
  });
}

export function manualCancel(baseUrl: string, fetcher: Fetcher): Promise<unknown> {
  return apiRequest(baseUrl, fetcher, "/nori/leader/manual/cancel", {
    method: "POST",
    action: "Cancel manual calibration",
  });
}

export function getManualStatus(baseUrl: string, fetcher: Fetcher): Promise<ManualStatus> {
  return apiRequest<ManualStatus>(baseUrl, fetcher, "/nori/leader/manual/status", {
    action: "Load manual calibration status",
  });
}

export function autoStart(
  baseUrl: string,
  fetcher: Fetcher,
  side: LeaderAutoSide,
  calibrationId: string,
  confirmPowered: boolean,
  port?: string
): Promise<unknown> {
  return apiRequest(baseUrl, fetcher, "/nori/leader/auto/start", {
    method: "POST",
    body: {
      side,
      calibration_id: calibrationId,
      confirm_powered: confirmPowered,
      port: port || null,
    },
    action: "Start powered auto calibration",
  });
}

export function autoStop(baseUrl: string, fetcher: Fetcher): Promise<unknown> {
  return apiRequest(baseUrl, fetcher, "/nori/leader/auto/stop", {
    method: "POST",
    action: "Stop powered auto calibration",
  });
}

export function getAutoStatus(baseUrl: string, fetcher: Fetcher): Promise<AutoStatus> {
  return apiRequest<AutoStatus>(baseUrl, fetcher, "/nori/leader/auto/status", {
    action: "Load powered auto calibration status",
  });
}

export function readLeaderLive(
  baseUrl: string,
  fetcher: Fetcher,
  calibrationId: string,
  port?: string
): Promise<LeaderLiveResponse> {
  const params = new URLSearchParams({ calibration_id: calibrationId });
  if (port) params.set("port", port);
  return apiRequest<LeaderLiveResponse>(baseUrl, fetcher, `/nori/leader/live?${params.toString()}`, {
    action: "Read leader live positions",
  });
}

export function stopLeaderLive(baseUrl: string, fetcher: Fetcher): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>(baseUrl, fetcher, "/nori/leader/live/stop", {
    method: "POST",
    action: "Stop leader live reader",
  });
}
