// NORI: Additive (SDK v1 mock mode). Browser smoke for `@nori/sdk/mock` — the half that Node
// unit tests structurally cannot reach: the WebRTC shell (RTCPeerConnection negotiation, the
// robot-opened 'control' data channel, canvas captureStream video, ImageCapture stills) and the
// full RemoteTeleop session lifecycle against it.
//
// WHY THIS EXISTS: the mock's whole promise is that RemoteTeleop runs its REAL code path, so the
// only proof that promise holds is running that path in a real browser. The 2026-07-16 review
// found two bugs living exactly here (a ready-retry race that tore down in-flight negotiations,
// and dropped ICE candidates) that no Node test could have caught, plus a dropped `bye` that
// broke reconnect-after-stop. Every one of those has a case below.
//
// Run: `npm run smoke:mock` (headless, CI-able) or open /mock-smoke.html in a browser.
// Results land in `window.__SMOKE__` for the CDP driver (scripts/mock-smoke.mjs) and are
// rendered to the page for a human.

import { RemoteTeleop, type TelemetryView } from "@nori/sdk";
import { createMockRobot } from "@nori/sdk/mock";

export interface SmokeResult {
  name: string;
  ok: boolean;
  detail?: string;
}
export interface SmokeReport {
  done: boolean;
  pass: number;
  fail: number;
  results: SmokeResult[];
}

declare global {
  interface Window {
    __SMOKE__?: SmokeReport;
  }
}

const report: SmokeReport = { done: false, pass: 0, fail: 0, results: [] };

function emit(r: SmokeResult) {
  report.results.push(r);
  if (r.ok) report.pass++;
  else report.fail++;
  render();
  // eslint-disable-next-line no-console
  console.log(`[smoke] ${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
}

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    emit({ name, ok: true });
  } catch (e) {
    emit({ name, ok: false, detail: (e as Error).message });
  }
}

// Poll until `pred` is true. Every wait in this file is bounded — a hang must surface as a named
// failure, never as a silent timeout of the whole run.
function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const poll = () => {
      if (pred()) return resolve();
      if (performance.now() - t0 > ms) return reject(new Error(`timeout after ${ms}ms waiting for ${label}`));
      setTimeout(poll, 50);
    };
    poll();
  });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function render() {
  const el = document.getElementById("results");
  if (!el) return;
  el.innerHTML = report.results
    .map(
      (r) =>
        `<li class="${r.ok ? "ok" : "bad"}"><b>${r.ok ? "PASS" : "FAIL"}</b> ${r.name}` +
        (r.detail ? `<br><small>${r.detail}</small>` : "") +
        `</li>`
    )
    .join("");
  const sum = document.getElementById("summary");
  if (sum) {
    sum.textContent = report.done
      ? `${report.fail === 0 ? "ALL PASS" : "FAILURES"} — ${report.pass} passed, ${report.fail} failed`
      : `running… ${report.pass + report.fail} done`;
    sum.className = report.done ? (report.fail === 0 ? "ok" : "bad") : "";
  }
}

// A RemoteTeleop wired to a mock robot with the options an external dev would use. Mirrors the
// README's mock quick-start exactly — including `stun: ""` (no STUN: the mock must never touch
// the network), which is precisely the config that used to crash RTCPeerConnection.
function makeTeleop(
  signaling: ReturnType<typeof createMockRobot>["signaling"],
  token: string,
  hooks: {
    videoEl?: HTMLVideoElement;
    onTelemetry?: (t: TelemetryView) => void;
    onConnState?: (s: string) => void;
    onFailure?: (reason: string) => void;
    onLog?: (m: string) => void;
  } = {}
) {
  return new RemoteTeleop({
    signaling,
    videoEl: hooks.videoEl,
    token,
    stun: "",
    turnUrls: [],
    turnUser: "",
    turnCred: "",
    forceRelay: false,
    arm: "right",
    onLog: (m) => hooks.onLog?.(m),
    onConnState: (s) => hooks.onConnState?.(s),
    onConnectStatus: (s) => {
      // ConnectStatus names the failure `reason` (not `failure`) — see the ConnectFailure union.
      if (s.phase === "failed" && s.reason) hooks.onFailure?.(s.reason);
    },
    onTelemetry: (t) => hooks.onTelemetry?.(t),
    onMode: () => {},
    onControlActive: () => {},
  });
}

export async function runSmoke(): Promise<SmokeReport> {
  // ---- Scenario A: a full open-room session -------------------------------------------------
  const robotLogs: string[] = [];
  const robot = createMockRobot({ log: (m) => robotLogs.push(m) });

  const videoEl = document.createElement("video");
  videoEl.muted = true;
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  document.getElementById("video-host")?.appendChild(videoEl);

  let tel: TelemetryView | null = null;
  let connState = "";
  const teleop = makeTeleop(robot.signaling, "", {
    videoEl,
    onTelemetry: (t) => { tel = t; },
    onConnState: (s) => { connState = s; },
  });

  await check("session connects over real WebRTC (in-page peer)", async () => {
    await teleop.start();
    await waitFor(() => connState === "connected", 10000, "connState=connected");
  });

  await check("handshake ack parses: descriptor + watchdog profile", async () => {
    await waitFor(() => teleop.robotInfo() !== null, 5000, "robotInfo()");
    const info = teleop.robotInfo()!;
    assert(info.accepted, "ack not accepted");
    assert(info.descriptor?.joints?.length === 12, `expected 12 joints, got ${info.descriptor?.joints?.length}`);
    assert(info.descriptor?.cameras?.length === 4, "expected 4 cameras");
    assert(info.watchdogProfile?.t_stop_ms === 1000, "watchdog profile missing");
  });

  await check("telemetry streams over the data channel", async () => {
    // NOTE: onTelemetry does NOT only fire for daemon telemetry frames — RemoteTeleop also emits
    // a view on its 1 Hz videoNet/ABR tick (so the net chip stays live while the daemon is down),
    // and that one carries an EMPTY state. So wait for a frame with joints, not merely the first
    // callback. Asserting on the first emit is a race a consumer can lose on a real robot too.
    await waitFor(() => typeof tel?.state["right_arm_shoulder_pan.pos"] === "number", 5000, "a telemetry frame with joint state");
    const t = tel!;
    assert(Object.keys(t.state).length >= 12, `expected >=12 state keys, got ${Object.keys(t.state).length}`);
    assert((t.loopHz ?? 0) >= 45, `loopHz looks wrong: ${t.loopHz}`);
    assert(t.safety === "ok", `safety=${t.safety}`);
    assert(typeof t.tempC === "number" && t.tempC > 0, "pi temp missing");
  });

  await check("video track arrives; videoStream() exposes it", async () => {
    await waitFor(() => (teleop.videoStream()?.getVideoTracks().length ?? 0) > 0, 10000, "video track");
    const track = teleop.videoStream()!.getVideoTracks()[0];
    assert(track.readyState === "live", `track ${track.readyState}`);
  });

  await check("camera_layout arrives and cameraView(role) crops a tile", async () => {
    await waitFor(() => teleop.cameraLayoutInfo() !== null, 5000, "camera layout");
    const layout = teleop.cameraLayoutInfo()!;
    assert(layout.tiles.length === 4, "expected 4 tiles");
    const view = teleop.cameraView("left_wrist");
    assert(view !== null, "cameraView(left_wrist) returned null");
    assert(view!.stream.getVideoTracks().length > 0, "cropped stream has no track");
    view!.stop();
    assert(teleop.cameraView("no_such_cam") === null, "unknown role must return null, not the composite");
  });

  await check("captureFrame() grabs real pixels (ImageCapture path)", async () => {
    // Retry: the track goes live slightly before the first painted frame is grabbable.
    let blob: Blob | null = null;
    for (let i = 0; i < 40 && !(blob && blob.size > 0); i++) {
      blob = await teleop.captureFrame();
      if (!blob) await sleep(200);
    }
    assert(blob && blob.size > 0, "captureFrame returned no pixels after 8s of retries");
  });

  await check("captureFrame(role) crops one tile, and rejects an unknown role", async () => {
    const full = await teleop.captureFrame();
    const tile = await teleop.captureFrame("image/jpeg", 0.7, "left_wrist");
    assert(tile && tile.size > 0, "per-camera captureFrame returned nothing");
    assert(full && tile.size < full.size, "tile should be smaller than the full composite");
    assert((await teleop.captureFrame("image/jpeg", 0.7, "nope")) === null, "unknown role must be null");
  });

  await check("jog drives the sim through the real control channel", async () => {
    const before = tel!.state["right_arm_shoulder_pan.pos"];
    teleop.setExternalJog({ right_arm: { shoulder_pan: 1.0 } } as never);
    await sleep(600);
    teleop.setExternalJog(null);
    const after = tel!.state["right_arm_shoulder_pan.pos"];
    assert(after > before + 1, `joint did not move: ${before} -> ${after}`);
  });

  await check("sendAction + awaitAction resolves terminal", async () => {
    const id = teleop.nextActionId();
    teleop.sendAction({ "right_arm_wrist_roll.pos": 25 }, id);
    const status = await teleop.awaitAction(id, { timeoutMs: 8000 });
    assert(status.state === "done", `expected done, got ${status.state} ${status.reason ?? ""}`);
  });

  await check("estop latches, reset_latch clears", async () => {
    teleop.command("estop");
    await waitFor(() => tel!.safety === "latched", 3000, "safety=latched");
    teleop.command("reset_latch");
    await waitFor(() => tel!.safety === "ok", 3000, "safety=ok");
  });

  // The 2026-07-16 review: stop()'s bye was dropped by the loopback, so the robot never tore
  // down and the NEXT start() hung forever on a stale-but-'open' data channel.
  await check("stop() delivers bye and the robot tears down", async () => {
    await teleop.stop();
    await waitFor(() => robotLogs.some((l) => l.includes("operator bye")), 3000, "robot to see the bye");
  });

  await check("reconnect after stop() (the regression the dropped bye caused)", async () => {
    let tel2: TelemetryView | null = null;
    let conn2 = "";
    const teleop2 = makeTeleop(robot.signaling, "", {
      onTelemetry: (t) => { tel2 = t; },
      onConnState: (s) => { conn2 = s; },
    });
    await teleop2.start();
    await waitFor(() => conn2 === "connected", 10000, "second session connState=connected");
    await waitFor(() => tel2 !== null, 5000, "second session telemetry");
    await teleop2.stop();
  });

  robot.stop();

  // ---- Scenario B: the token auth path ------------------------------------------------------
  // The review found the mock rotated its nonce on every failed ready, so a CORRECT token could
  // never converge and reported bad_access_code.
  await check("correct token completes the HMAC handshake", async () => {
    const authRobot = createMockRobot({ token: "s3cret-room-token" });
    let conn = "";
    const t = makeTeleop(authRobot.signaling, "s3cret-room-token", { onConnState: (s) => { conn = s; } });
    try {
      await t.start();
      await waitFor(() => conn === "connected", 12000, "authenticated connState=connected");
    } finally {
      await t.stop();
      authRobot.stop();
    }
  });

  await check("wrong token is rejected as bad_access_code", async () => {
    const authRobot = createMockRobot({ token: "s3cret-room-token" });
    let failure = "";
    let conn = "";
    const t = makeTeleop(authRobot.signaling, "wrong-token", {
      onConnState: (s) => { conn = s; },
      onFailure: (f) => { failure = f; },
    });
    try {
      await t.start();
      // The SDK debounces a nack for NACK_CONFIRM_MS (2.5 s) before calling it a bad code. Stay
      // well under WAIT_FOR_ROBOT_MS (12 s) so a pass here can't be the "nobody answered"
      // deadline wearing a different hat.
      await waitFor(() => failure === "bad_access_code", 8000, "bad_access_code");
      assert(conn !== "connected", "a wrong token must not reach connected");
    } finally {
      await t.stop();
      authRobot.stop();
    }
  });

  report.done = true;
  render();
  return report;
}

// Auto-run when loaded as a page (the html entry imports this module).
if (typeof document !== "undefined") {
  window.__SMOKE__ = report;
  runSmoke().catch((e) => {
    emit({ name: "smoke harness", ok: false, detail: (e as Error).message });
    report.done = true;
    render();
  });
}
