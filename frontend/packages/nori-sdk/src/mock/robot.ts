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

export function createMockRobot(opts?: MockRobotOptions): MockRobotHandle {
  const sim = opts?.sim ?? new MockDaemonSim();
  const token = opts?.token ?? "";
  const telemetryMs = 1000 / (opts?.telemetryHz ?? 20);
  const log = opts?.log ?? (() => {});
  const { transport, robot: port } = createLoopbackSignaling({ latencyMs: opts?.latencyMs });

  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let offerDebounce: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let nonce = "mock-nonce-1";
  let nonceCounter = 1;
  let canvas: HTMLCanvasElement | null = null;
  let stopped = false;

  const dcSend = (obj: Record<string, unknown>) => {
    if (dc && dc.readyState === "open") dc.send(JSON.stringify(obj));
  };

  const teardownSession = () => {
    generation++;
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
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
      const stream = canvas.captureStream(15);
      for (const track of stream.getVideoTracks()) pc.addTrack(track, stream);
    }

    const channel = pc.createDataChannel("control"); // robot opens 'control' (teleop.ts:1357)
    dc = channel;
    channel.onopen = () => {
      if (gen !== generation) return;
      log("mock robot: control channel open");
      dcSend(sim.ackFrame());
      const layout = sim.cameraLayoutFrame();
      if (layout) dcSend(layout);
      dcSend(sim.daemonStatusFrame("online"));
      tickTimer = setInterval(() => {
        const now = performance.now();
        for (const f of sim.tick(now)) dcSend(f);
        drawComposite(now);
      }, telemetryMs);
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

  port.onOperatorOpen(() => {
    if (token) port.announce({ nonce }); // carry the auth nonce, like a token-bearing robot
  });

  port.onReady((p) => {
    if (stopped) return;
    if (dc && dc.readyState === "open") return; // live session: ignore the 2 s keepalive retries
    if (token) {
      void verifyMac(token, nonce, p.mac).then((ok) => {
        if (ok) {
          scheduleOffer();
        } else {
          log("mock robot: bad/missing mac — nack + re-announce");
          port.sendNack({ reason: "unauthorized" });
          nonce = `mock-nonce-${++nonceCounter}`;
          port.announce({ nonce });
        }
      });
    } else {
      scheduleOffer();
    }
  });

  port.onSdp((p) => {
    if (p.type !== "answer" || !pc) return;
    void pc.setRemoteDescription({ type: "answer", sdp: p.sdp }).catch((e) => log("mock robot: answer failed: " + (e as Error).message));
  });

  port.onIce((p) => {
    if (!pc || !pc.remoteDescription) return;
    void pc.addIceCandidate({ candidate: p.candidate, sdpMLineIndex: p.sdpMLineIndex ?? undefined }).catch(() => {});
  });

  port.onBye(() => {
    log("mock robot: operator bye");
    teardownSession();
  });

  return {
    signaling: transport,
    sim,
    restart() {
      teardownSession();
      if (token) {
        nonce = `mock-nonce-${++nonceCounter}`;
        port.announce({ nonce });
      } else {
        port.announce({});
      }
    },
    stop() {
      stopped = true;
      if (offerDebounce) clearTimeout(offerDebounce);
      teardownSession();
      void transport.close();
    },
  };
}

// Same HMAC-SHA256-hex the SDK computes over (token, nonce) — teleop.ts hmacHex, robot side.
async function verifyMac(token: string, nonce: string, mac?: string): Promise<boolean> {
  if (!mac) return false;
  if (typeof crypto === "undefined" || !crypto.subtle) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(nonce));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === mac;
}
