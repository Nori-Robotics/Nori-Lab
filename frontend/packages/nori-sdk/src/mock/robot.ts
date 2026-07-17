// NORI: Additive file (SDK v1 mock mode — docs/sdk_v1_finalization.md item 1).
// MockRobot: the browser shell that makes MockDaemonSim reachable through the REAL RemoteTeleop
// code path. It plays the robot side of the wire end to end: answers the room handshake
// (ready / robot_here+nonce / HMAC / nack), builds an in-page RTCPeerConnection, streams a
// canvas-drawn test-pattern composite (per-camera tiles honoring the camera_layout it sends,
// so cameraView()/snapshot(role) work), opens the "control" data channel, and pumps the sim.
//
// Because RemoteTeleop runs unmodified — real signaling contract, real WebRTC, real frame
// parsing — the mock can never drift from the SDK API: anything the SDK grows works against
// the mock the day it lands, or fails loudly here first.
//
// Environment: BROWSER ONLY (RTCPeerConnection + canvas.captureStream). Importing is Node-safe;
// constructing requires a browser (vitest browser mode / playwright for CI). The pure sim in
// mock/sim.ts is the Node-testable part.
//
// v1 limits (documented in the README section): no audio tracks (joinCall degrades to
// local-only), no perception frames (use injectPerception), video is a test pattern.

import { MockDaemonSim } from "./sim";
import { createLoopbackSignaling, type MockRobotSignalingPort } from "./loopback-signaling";
import { hmacHex } from "../teleop";
import type { SignalingTransport } from "../signaling";

export interface MockRobotOptions {
  sim?: MockDaemonSim;
  // Room token to enforce. "" (default) = open room, matching the dev-bench default. Set it to
  // exercise the auth path: a RemoteTeleop with the wrong token gets the real nack behavior.
  token?: string;
  telemetryHz?: number; // default 20 (the bridge's ~15-25 Hz throttled band)
  video?: boolean; // default true; false = data-only session (still fully drivable)
  latencyMs?: number; // artificial one-way signaling latency
  log?: (msg: string) => void;
}

export interface MockRobotHandle {
  // Hand this to RemoteTeleop as `signaling:` — everything else is the normal SDK flow.
  signaling: SignalingTransport;
  sim: MockDaemonSim;
  // Simulate a robot-side restart: tears the session down; RemoteTeleop's 2 s ready retry
  // then negotiates a fresh session, exactly like a real bridge restart.
  restart(): void;
  stop(): void;
}

const TILE_W = 320;
const TILE_H = 240;
// The composite is captured at 15 fps (the real robot's power-constrained operating point), so
// redrawing faster than this can never reach the wire — the draw timer is deliberately NOT the
// telemetry timer, which devs may legitimately raise to 50 Hz.
const DRAW_FPS = 15;
// A negotiation that hasn't opened its data channel within this window is presumed dead and a
// fresh 'ready' may rebuild it. Must exceed the SDK's 2 s ready-retry interval by enough that a
// slow-but-live handshake (throttled background tab, loaded CI browser) is never torn down
// mid-flight — doing so destroys the peer the operator is still answering.
const NEGOTIATION_GRACE_MS = 8000;
// Throttle for robot_here / nack, matching the bridge's 2 s `_announce`/`_nack` rate limits.
const HANDSHAKE_RATE_LIMIT_MS = 2000;

export function createMockRobot(opts?: MockRobotOptions): MockRobotHandle {
  const sim = opts?.sim ?? new MockDaemonSim();
  const token = opts?.token ?? "";
  const telemetryMs = 1000 / (opts?.telemetryHz ?? 20);
  const log = opts?.log ?? (() => {});
  const { transport, robot: port } = createLoopbackSignaling({ latencyMs: opts?.latencyMs });

  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let drawTimer: ReturnType<typeof setInterval> | null = null;
  let offerDebounce: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let negotiatingSince = 0;
  let pendingIce: RTCIceCandidateInit[] = [];
  let nonce = "mock-nonce-1";
  let nonceCounter = 1;
  let lastAnnounceMs = -Infinity;
  let lastNackMs = -Infinity;
  let canvas: HTMLCanvasElement | null = null;
  let stopped = false;

  const dcSend = (obj: Record<string, unknown>) => {
    if (dc && dc.readyState === "open") dc.send(JSON.stringify(obj));
  };

  // True while a session is live OR still negotiating — the window in which a 'ready' retry must
  // NOT rebuild the peer. Checking only `dc.readyState === "open"` let every 2 s retry tear down
  // an in-flight handshake, so a negotiation slower than 2 s could churn forever.
  const sessionBusy = () =>
    (dc !== null && dc.readyState === "open") ||
    (negotiatingSince !== 0 && performance.now() - negotiatingSince < NEGOTIATION_GRACE_MS);

  const teardownSession = () => {
    generation++;
    negotiatingSince = 0;
    pendingIce = [];
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    if (drawTimer) clearInterval(drawTimer);
    drawTimer = null;
    if (dc) try { dc.close(); } catch { /* already closed */ }
    dc = null;
    if (pc) try { pc.close(); } catch { /* already closed */ }
    pc = null;
  };

  const drawComposite = (nowMs: number) => {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const layout = sim.cameraLayoutFrame();
    const tiles = layout ? (layout.tiles as string[]) : (sim.descriptor.cameras ?? ["front"]);
    const cols = layout ? (layout.cols as number) : 1;
    const state = sim.state();
    tiles.forEach((role, i) => {
      const x = (i % cols) * TILE_W;
      const y = Math.floor(i / cols) * TILE_H;
      ctx.fillStyle = `hsl(${(i * 87) % 360}, 25%, 22%)`;
      ctx.fillRect(x, y, TILE_W, TILE_H);
      ctx.strokeStyle = "#888";
      ctx.strokeRect(x + 1, y + 1, TILE_W - 2, TILE_H - 2);
      // Motion cue: a dot orbiting on sim time, its radius driven by a live joint — jogging
      // visibly changes the picture, which is what a dev checking cameraView() needs to see.
      const side = role.includes("left") ? "left" : "right";
      const joint = state[`${side}_arm_shoulder_pan.pos`] ?? 0;
      const a = (nowMs / 1000) % (Math.PI * 2);
      const r = 40 + (joint / 100) * 35;
      ctx.fillStyle = "#e8b23a";
      ctx.beginPath();
      ctx.arc(x + TILE_W / 2 + Math.cos(a) * r, y + TILE_H / 2 + Math.sin(a) * r, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#eee";
      ctx.font = "16px monospace";
      ctx.fillText(`${role} [mock]`, x + 10, y + 24);
      ctx.font = "12px monospace";
      ctx.fillText(`t=${(nowMs / 1000).toFixed(1)}s pan=${joint.toFixed(0)}`, x + 10, y + TILE_H - 12);
    });
  };

  const buildSession = async () => {
    teardownSession();
    if (stopped) return;
    const gen = generation;
    negotiatingSince = performance.now(); // guards against retry-driven teardown (sessionBusy)
    log("mock robot: building session (fresh peer + offer)");
    pc = new RTCPeerConnection(); // no ICE servers: in-page host candidates connect directly

    if (opts?.video !== false && typeof document !== "undefined") {
      if (!canvas) {
        canvas = document.createElement("canvas");
        const n = (sim.descriptor.cameras ?? ["front"]).length;
        const cols = n < 2 ? 1 : Math.ceil(Math.sqrt(n));
        canvas.width = cols * TILE_W;
        canvas.height = Math.ceil(n / cols) * TILE_H;
      }
      drawComposite(performance.now());
      const stream = canvas.captureStream(DRAW_FPS);
      for (const track of stream.getVideoTracks()) pc.addTrack(track, stream);
    }

    const channel = pc.createDataChannel("control"); // robot opens 'control' (teleop.ts:1357)
    dc = channel;
    channel.onopen = () => {
      if (gen !== generation) return;
      negotiatingSince = 0; // negotiation finished; the dc-open branch of sessionBusy takes over
      log("mock robot: control channel open");
      dcSend(sim.ackFrame());
      const layout = sim.cameraLayoutFrame();
      if (layout) dcSend(layout);
      dcSend(sim.daemonStatusFrame("online"));
      tickTimer = setInterval(() => {
        for (const f of sim.tick(performance.now())) dcSend(f);
      }, telemetryMs);
      // Painting rides its own timer at the capture rate: redraws beyond captureStream's fps are
      // rasterization the wire throws away, and telemetryHz is the dev's knob, not the video's.
      if (canvas) drawTimer = setInterval(() => drawComposite(performance.now()), 1000 / DRAW_FPS);
    };
    channel.onmessage = (ev) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return; // a real bridge skips unparseable lines too
      }
      for (const f of sim.handleFrame(frame, performance.now())) dcSend(f);
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate && gen === generation) {
        port.sendIce({ candidate: ev.candidate.candidate, sdpMLineIndex: ev.candidate.sdpMLineIndex });
      }
    };

    const offer = await pc.createOffer();
    if (gen !== generation || !pc) return; // torn down while negotiating
    await pc.setLocalDescription(offer);
    port.sendSdp({ type: "offer", sdp: offer.sdp ?? "" });
  };

  // Debounced: the open+robot_here double-ready (and the 2 s retry) collapse to one offer.
  const scheduleOffer = () => {
    if (offerDebounce) clearTimeout(offerDebounce);
    offerDebounce = setTimeout(() => {
      offerDebounce = null;
      void buildSession();
    }, 75);
  };

  // The room handshake below mirrors the real bridge (rpi5/media/webrtc_robot.py `_on_open` /
  // `_handle_sig("ready")` / `_announce` / `_nack`) deliberately — a mock that handshakes
  // differently teaches devs to code against a handshake that doesn't exist.
  const announce = (rateLimited = false) => {
    const now = performance.now();
    if (rateLimited && now - lastAnnounceMs < HANDSHAKE_RATE_LIMIT_MS) return;
    lastAnnounceMs = now;
    port.announce({ nonce });
  };

  // Rate-limited exactly like the bridge's `_nack`: the operator re-sends 'ready' every 2 s
  // while it waits, so an unauthorized client would otherwise pull a nack out of us on every
  // retry, forever — and since each nack answers with a re-announce, an unthrottled pair spins
  // into a hot ready/nack/announce loop that pins the dev's CPU.
  const nack = (reason: string) => {
    const now = performance.now();
    if (now - lastNackMs < HANDSHAKE_RATE_LIMIT_MS) return;
    lastNackMs = now;
    port.sendNack({ reason });
  };

  // The bridge announces on ITS signaling open, token or not (`_on_open` -> `_announce`).
  port.onOperatorOpen(() => announce());

  port.onReady((p) => {
    if (stopped) return;
    if (sessionBusy()) return; // live or still-negotiating session: ignore the 2 s ready retries
    if (!token) {
      scheduleOffer(); // no token configured = open/dev room, always authorized
      return;
    }
    void verifyMac(token, nonce, p.mac).then((ok) => {
      if (stopped || sessionBusy()) return;
      if (ok) {
        scheduleOffer();
        return;
      }
      // Only a PRESENT-but-WRONG mac is a bad access code. The operator's FIRST ready is always
      // mac-less by design (it can't compute an HMAC until a robot_here delivers the nonce), so
      // that one is an expected handshake step, not an auth failure — nacking it is what made
      // every normal connect flash a spurious "wrong access code" on the real robot (W2.6).
      // The nonce is per-session and NEVER rotates on failure: rotating it made each retry's mac
      // stale against the freshly bumped nonce, so a CORRECT token could never converge.
      if (p.mac) {
        log("mock robot: unauthorized operator (wrong token) — rejected");
        nack("unauthorized");
      } else {
        log("mock robot: ready without nonce (pre-handshake) — re-announcing");
      }
      announce(true); // (re)share the nonce for a legit late/handshaking operator
    });
  });

  port.onSdp((p) => {
    if (p.type !== "answer" || !pc) return;
    const gen = generation;
    const peer = pc;
    void peer
      .setRemoteDescription({ type: "answer", sdp: p.sdp })
      .then(() => {
        if (gen !== generation) return;
        // Drain candidates that raced the answer (below).
        const queued = pendingIce;
        pendingIce = [];
        for (const c of queued) void peer.addIceCandidate(c).catch(() => {});
      })
      .catch((e) => log("mock robot: answer failed: " + (e as Error).message));
  });

  port.onIce((p) => {
    if (!pc) return;
    const cand = { candidate: p.candidate, sdpMLineIndex: p.sdpMLineIndex ?? undefined };
    // A candidate can only be added once the answer is applied, and the loopback delivers the
    // answer and the operator's host candidates back-to-back — so buffer instead of dropping
    // (teleop.ts buffers the symmetric case in pendingIce). Dropped candidates left the robot
    // relying on peer-reflexive discovery, which made the mock flakier than the real transport.
    if (!pc.remoteDescription) {
      pendingIce.push(cand);
      return;
    }
    void pc.addIceCandidate(cand).catch(() => {});
  });

  port.onBye(() => {
    log("mock robot: operator bye");
    teardownSession();
  });

  return {
    signaling: transport,
    sim,
    restart() {
      // A restart is a new session, so the auth challenge rotates (the bridge mints its nonce
      // per session). The un-rate-limited announce is what prompts the operator to re-handshake.
      teardownSession();
      nonce = `mock-nonce-${++nonceCounter}`;
      lastNackMs = -Infinity;
      announce();
    },
    stop() {
      stopped = true;
      if (offerDebounce) clearTimeout(offerDebounce);
      teardownSession();
      void transport.close();
    },
  };
}

// Verify with the operator's own primitive (teleop.ts hmacHex) rather than a second copy of the
// crypto — the two could otherwise drift and break the token path silently.
async function verifyMac(token: string, nonce: string, mac?: string): Promise<boolean> {
  if (!mac) return false;
  if (typeof crypto === "undefined" || !crypto.subtle) return false;
  try {
    return (await hmacHex(token, nonce)) === mac;
  } catch {
    return false;
  }
}
