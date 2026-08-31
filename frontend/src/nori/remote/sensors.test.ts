import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteTeleop, parseAck } from "@nori/sdk";
import type { ImuSample, LidarScan, SensorStreamStatus } from "@nori/sdk";


type Raw = {
  ackInfo: unknown;
  dcSend: (frame: Record<string, unknown>) => boolean;
  handleTelemetry: (data: string) => void;
};

function harness(capabilities = ["sensor_streams"]) {
  const lidar: LidarScan[] = [];
  const imu: ImuSample[] = [];
  const statuses: SensorStreamStatus[] = [];
  // `link.open` models the control channel going away under an in-flight request.
  const link = { open: true };
  const teleop = new RemoteTeleop({
    arm: "right",
    onLidarScan: (value: LidarScan) => lidar.push(value),
    onImu: (value: ImuSample) => imu.push(value),
    onSensorStreamStatus: (value: SensorStreamStatus) => statuses.push(value),
    // Just enough option surface for the real stop() teardown to run in-process.
    signaling: { sendBye: () => {}, close: async () => {} },
    onTelemetry: () => {},
    onControlActive: () => {},
    onConnState: () => {},
  } as never);
  const raw = teleop as unknown as Raw;
  raw.ackInfo = parseAck({
    type: "ack", accepted: true, protocol_version: 1, capabilities,
  });
  const sent: Record<string, unknown>[] = [];
  raw.dcSend = (frame) => { sent.push(frame); return link.open; };
  return { teleop, raw, sent, lidar, imu, statuses, link };
}

describe("LiDAR and IMU streams", () => {
  it("sends a bounded correlated configuration and resolves its matching status", async () => {
    const { teleop, raw, sent, statuses } = harness();
    const pending = teleop.configureSensorStreams({
      lidarHz: 5, imuHz: 20, lidarMaxPoints: 180,
    });
    expect(sent[0]).toMatchObject({
      type: "sensor_stream", action: "configure",
      lidar_hz: 5, imu_hz: 20, lidar_max_points: 180,
    });
    expect(String(sent[0].request_id)).toMatch(/^[0-9a-f-]{36}$/);
    raw.handleTelemetry(JSON.stringify({
      type: "sensor_stream_status",
      request_id: sent[0].request_id,
      ok: true,
      lidar_hz: 5,
      imu_hz: 20,
      lidar_max_points: 180,
      lidar_available: true,
      imu_available: false,
    }));
    await expect(pending).resolves.toMatchObject({
      ok: true, lidarHz: 5, imuHz: 20, lidarMaxPoints: 180,
      lidarAvailable: true, imuAvailable: false,
    });
    expect(statuses).toHaveLength(1);
    expect(teleop.latestSensorStreamStatus()?.requestId).toBe(sent[0].request_id);
  });

  it("parses scans, preserves null readings, and caches the latest frame", () => {
    const { teleop, raw, lidar } = harness();
    raw.handleTelemetry(JSON.stringify({
      type: "lidar_scan",
      stamp: { sec: 12, nanosec: 34 },
      frame_id: "laser",
      angle_min_rad: -1,
      angle_max_rad: 1,
      angle_increment_rad: 0.5,
      time_increment_s: 0.001,
      scan_time_s: 0.1,
      range_min_m: 0.05,
      range_max_m: 12,
      source_points: 8,
      ranges_m: [1.2, null, 2.3],
      intensities: [5, null, 8],
    }));
    expect(lidar[0]).toMatchObject({
      stamp: { sec: 12, nanosec: 34 }, frameId: "laser",
      sourcePoints: 8, rangesM: [1.2, null, 2.3],
    });
    expect(teleop.latestLidarScan()).toBe(lidar[0]);
  });

  it("parses the complete IMU shape and rejects impossible requested rates", async () => {
    const { teleop, raw, imu, sent } = harness();
    raw.handleTelemetry(JSON.stringify({
      type: "imu",
      stamp: { sec: 56, nanosec: 78 },
      frame_id: "imu_link",
      orientation_xyzw: [0, 0, 0.5, 0.866],
      orientation_covariance: [0, 1, 2, 3, 4, 5, 6, 7, 8],
      angular_velocity_rad_s: [null, 0, 0.3],
      angular_velocity_covariance: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      linear_acceleration_m_s2: [0, 0, 9.81],
      linear_acceleration_covariance: [1, 1, 1, 1, 1, 1, 1, 1, 1],
    }));
    expect(imu[0].orientationXyzw).toEqual([0, 0, 0.5, 0.866]);
    expect(imu[0].angularVelocityRadS).toEqual([null, 0, 0.3]);
    expect(imu[0].linearAccelerationMS2).toEqual([0, 0, 9.81]);
    expect(teleop.latestImuSample()).toBe(imu[0]);

    await expect(teleop.configureSensorStreams({ imuHz: 51 }))
      .rejects.toThrow(/between 0 and 50/);
    expect(sent).toHaveLength(0);
  });

  it("preflights an explicitly absent sensor capability", async () => {
    const { teleop, sent } = harness(["record"]);
    await expect(teleop.getSensorStreamStatus()).rejects.toThrow(/sensor_streams/);
    expect(sent).toHaveLength(0);
  });
});

describe("sensor stream failure paths", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("marks a reply timeout unreachable and keeps the last effective settings", async () => {
    const { teleop, raw, sent } = harness();
    const configured = teleop.configureSensorStreams({ lidarHz: 5, imuHz: 20 });
    raw.handleTelemetry(JSON.stringify({
      type: "sensor_stream_status", request_id: sent[0].request_id, ok: true,
      lidar_hz: 5, imu_hz: 20, lidar_max_points: 180,
      lidar_available: true, imu_available: true,
    }));
    await configured;

    const pending = teleop.getSensorStreamStatus({ timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    // Unreachable reports the last values the ROBOT gave, not fabricated zeroes that
    // would read as "the sensors turned themselves off".
    await expect(pending).resolves.toMatchObject({
      ok: false, unreachable: true,
      lidarHz: 5, imuHz: 20, lidarMaxPoints: 180, lidarAvailable: true,
    });
  });

  it("resolves unreachable and arms no retry when the channel is closed", async () => {
    const { teleop, sent, link } = harness();
    link.open = false;
    const status = await teleop.getSensorStreamStatus();
    expect(status).toMatchObject({ ok: false, unreachable: true });
    expect(status.error).toMatch(/not open/);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(1);
  });

  it("drains an in-flight sensor waiter when the session stops", async () => {
    const { teleop } = harness();
    const pending = teleop.getSensorStreamStatus({ timeoutMs: 60_000 });
    await teleop.stop();
    await expect(pending).resolves.toMatchObject({ ok: false, unreachable: true });
  });
});
