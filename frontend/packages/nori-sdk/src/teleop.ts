// NORI: Additive file. Remote-mode operator client (M1 §e: the laptop app is the
// single control client). Framework-agnostic: this class owns the WebRTC + Supabase
// signaling + control-data-channel logic; the React page (pages/remote.tsx) only wires
// it to the DOM (video element, form, keyboard) and renders status.
//
// It is the TypeScript port of rpi5/media/webrtc_operator.html in NoriTeleop — same
// wire protocol, so it talks to the same `webrtc_robot.py` on the Pi:
//   * Supabase Realtime broadcast channel (room = NORI_ROOM) for SDP/ICE exchange
//   * the browser is the ANSWERER; a FRESH RTCPeerConnection per offer (robot restarts)
//   * control rides an UNRELIABLE data channel the robot opens ('control'), bridged on
//     the Pi to the daemon's NDJSON :7777
//   * auth: prove possession of the room token via HMAC-SHA256(token, robot-nonce)
//   * TURN is additive (STUN-direct preferred); forceRelay validates the relay path

import type { SignalingTransport } from "./signaling";
import { AudioLatencyProbe, audioLatencyEnabled } from "./audioLatency";

export type ControlMode = "cylindrical" | "joint";
export type ArmSide = "left" | "right";

// A ready-to-send `jog` payload (the inner object of {type:"control", jog:{...}}).
// VR feeds this in directly so it rides the exact same wire the keyboard does — the
// daemon's jog->IK->clamp->motor path is identical regardless of source. Values are
// normalized rates in [-1,1] per DOF (the daemon scales by its per-tick step).
export interface ExternalJog {
  left_arm?: Record<string, number>;
  right_arm?: Record<string, number>;
  base?: Record<string, number>;
  // Per-arm lift (velocity, [-1,1]). The robot has one lift per arm; drive them
  // independently. (Was a single `z_lift`.)
  left_lift?: number;
  right_lift?: number;
}

export interface TelemetryView {
  loopHz: number;
  safety: string;
  watchdog: string;
  tempC: number;
  active: boolean;
  // Measured ICE path (host/host = "lan", anything via STUN/TURN = "wan"); null until the
  // candidate pair resolves. Drives the daemon watchdog profile and the on-screen link chip.
  linkMode: "lan" | "wan" | null;
  // Per-motor Present_Current (the "virtual tactile" signal), keyed like "right_arm_gripper".
  // Same values fed to VR haptics; surfaced here for the on-screen grip-force readout.
  currents: Record<string, number>;
  // The daemon's lerobot-native telemetry `state` dict: every joint's "<motor>.pos"
  // (arm joints normalized [-100,100], grippers [0,100]) + base "x.vel"/"theta.vel".
  // Carried verbatim so a 3D pose view (C6) can run FK off the joint angles. NOTE: these
  // are NORMALIZED, not degrees — a future Pi-side `use_degrees` field will carry physical
  // angles for FK (the Pi owns the calibration + kinematic convention). Empty until the
  // daemon sends `state` (mock/real).
  // Since 2026-07-02 the daemon also adds "left_lift.pos"/"right_lift.pos" — software
  // multi-turn lift height (m3_m5 §5.5), rendered by the "Rail height" card (RailHeight in
  // TeleopStatus.tsx) and intended for the C6 Z offset. Units are real MILLIMETERS
  // (~115.6 mm per encoder rev — the HW-quoted 28.455 is for a shaft ~4x faster than the
  // encoder; corrected on-unit 2026-07-03), zero = pose at daemon start (startup-relative until
  // Pi-side stall homing lands, so values can be negative). The keys are OMITTED while the
  // Pi's tracker isn't valid — treat absence as "height unknown", not zero.
  state: Record<string, number>;
}

// Two-way call state (Phase 7 §B). Reported to the page via onCall so it can render the
// call bar + on-air indicators. Everything here is renegotiation-free: mic/camera attach to
// transceivers the robot already offered (R-X.1). Fields degrade gracefully when the robot
// hasn't yet offered audio/video m-lines (Pi M3/M6 pending) — micSending stays false.
export interface CallState {
  active: boolean;       // operator has joined the call (mic captured locally)
  micMuted: boolean;     // operator mic muted (track.enabled = false)
  micSending: boolean;   // mic is actually wired to a robot uplink transceiver (else: local-only)
  robotAudio: boolean;   // an inbound audio track from the robot is attached to the sink
  robotMicLive: boolean; // robot reports its mic is live (telemetry; reserved field)
  cameraOn: boolean;     // M6 (gated): operator camera is sending
}

export interface RemoteTeleopOptions {
  // Out-of-band signaling transport (SDP/ICE + room handshake). The fork injects a
  // SupabaseSignaling; an external SDK consumer supplies their own. See signaling.ts.
  signaling: SignalingTransport;
  videoEl: HTMLVideoElement;
  // Sink for the robot's inbound audio track. A separate element from videoEl because the
  // video element is muted for autoplay; audio must play from its own unmuted element.
  audioEl?: HTMLAudioElement;
  // --- multi-camera (optional; single-camera robots ignore all of this) ---------------------
  // The robot may send more than one video track (one per camera). `videoEl` above always
  // receives the PRIMARY feed (first track) so VR and single-camera clients keep working
  // unchanged. To render every feed (a grid), provide these:
  //   onVideoTrack   — fired once per inbound video track, keyed by a STABLE id (the transceiver
  //                    mid). Attach the stream to your own <video>; key your UI by this id.
  //   onVideoRemoved — that track ended (camera unplugged / pipeline restart).
  //   onCameraNames  — id -> human camera name, from the robot's `video_map` control message.
  //                    Arrives independently of the tracks (either order); relabel your tiles.
  onVideoTrack?: (id: string, stream: MediaStream) => void;
  onVideoRemoved?: (id: string) => void;
  onCameraNames?: (namesById: Record<string, string>) => void;
  // NOTE: the signaling ROOM is now owned by the SignalingTransport (it addresses the room),
  // so it's no longer a RemoteTeleop option. `token` stays here because RemoteTeleop itself
  // performs the HMAC auth handshake over whatever transport is injected.
  token: string; // room token (HMAC secret); "" = open dev room
  stun: string;
  turnUrls: string[];
  turnUser: string;
  turnCred: string;
  forceRelay: boolean;
  arm: ArmSide;
  onLog: (msg: string) => void;
  onConnState: (state: string) => void;
  onTelemetry: (t: TelemetryView) => void;
  onMode: (mode: ControlMode) => void;
  onControlActive: (active: boolean) => void;
  // Optional: per-motor Present_Current from telemetry (the virtual tactile signal).
  // VR haptics (M2 Phase 3) maps the gripper current to controller rumble.
  onCurrents?: (currents: Record<string, number>) => void;
  // Optional: two-way call state changes (mic/camera/robot-audio). Phase 7 §B.
  onCall?: (state: CallState) => void;
}

// Two schemes; 'm' toggles. Default = CYLINDRICAL (the rpi4 feel).
//  cylindrical: shoulder_pan + x/y reach (IK) + pitch + wrist_roll + gripper
//  joint (per-motor): each motor direct, top row +, bottom row -
// Exported so the on-screen control legend (pages/remote.tsx) derives from the SAME maps
// the jog stream uses — no hand-maintained second copy to drift out of sync (C3).
export const TASK_KEYS: Record<string, [string, number]> = {
  q: ["shoulder_pan", 1], e: ["shoulder_pan", -1],
  w: ["x", 1], s: ["x", -1], a: ["y", 1], d: ["y", -1],
  z: ["pitch", 1], x: ["pitch", -1], r: ["wrist_roll", 1], f: ["wrist_roll", -1],
  t: ["gripper", 1], g: ["gripper", -1],
};
export const JOINT_KEYS: Record<string, [string, number]> = {
  q: ["shoulder_pan", 1], a: ["shoulder_pan", -1],
  w: ["shoulder_lift", 1], s: ["shoulder_lift", -1],
  e: ["elbow_flex", 1], d: ["elbow_flex", -1],
  r: ["wrist_flex", 1], f: ["wrist_flex", -1],
  t: ["wrist_roll", 1], g: ["wrist_roll", -1],
  y: ["gripper", 1], h: ["gripper", -1],
};
export const BASE_KEYS: Record<string, [string, number]> = {
  i: ["linear", 1], k: ["linear", -1], j: ["angular", 1], l: ["angular", -1],
};
export const ZLIFT_KEYS: Record<string, number> = { u: 1, o: -1 };
export const CMD_KEYS: Record<string, string> = { " ": "estop", p: "reset_latch", c: "reset" };

// One legend row: the +/- key pair that drives a single DOF, ready to render (C3).
export interface KeybindRow { dof: string; posKey: string; negKey: string; }

// Collapse a `key -> [dof, ±1]` map into per-DOF +/- rows, preserving first-seen order so
// the legend reads in the same order as the physical key layout.
function rowsFromAxisMap(map: Record<string, [string, number]>): KeybindRow[] {
  const byDof = new Map<string, KeybindRow>();
  for (const [key, [dof, sign]] of Object.entries(map)) {
    const row = byDof.get(dof) ?? { dof, posKey: "", negKey: "" };
    if (sign > 0) row.posKey = key; else row.negKey = key;
    byDof.set(dof, row);
  }
  return [...byDof.values()];
}

// Structured control legend for a given mode — derived from the exported maps above so it
// can never drift from what the keys actually send.
export function keybindLegend(mode: ControlMode): {
  arm: KeybindRow[];
  base: KeybindRow[];
  lift: KeybindRow;
  commands: { key: string; label: string }[];
} {
  const [u, o] = Object.entries(ZLIFT_KEYS).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return {
    arm: rowsFromAxisMap(mode === "joint" ? JOINT_KEYS : TASK_KEYS),
    base: rowsFromAxisMap(BASE_KEYS),
    lift: { dof: "lift (selected arm)", posKey: u, negKey: o },
    commands: [
      { key: "SPACE", label: "E-STOP" },
      { key: "P", label: "reset latch" },
      { key: "C", label: "reset" },
      { key: "M", label: "toggle mode" },
    ],
  };
}

const JOG_HZ_MS = 20; // 50 Hz level-jog
const BUFFER_LIMIT = 16384; // skip a jog frame if the channel is congested

async function hmacHex(key: string, msg: string): Promise<string> {
  if (!crypto.subtle) {
    throw new Error("crypto.subtle unavailable — open the app over http://localhost or https");
  }
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class RemoteTeleop {
  private o: RemoteTeleopOptions;
  private pc: RTCPeerConnection | null = null;
  private remoteSet = false;
  private pendingIce: RTCIceCandidateInit[] = [];
  private connected = false;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private latencyProbe: AudioLatencyProbe | null = null; // R-X.2 audio-latency harness (per peer)
  private jogTimer: ReturnType<typeof setInterval> | null = null;
  private controlCh: RTCDataChannel | null = null;
  // --- multi-camera track routing (reset per fresh peer) ---
  private videoByMid = new Map<string, MediaStream>(); // mid -> its inbound stream
  private camNameByMid = new Map<string, string>();     // mid -> camera name (from video_map)
  private primaryMid: string | null = null;             // which track feeds `videoEl`
  private curMac = ""; // HMAC of the robot's nonce, proving we hold the token
  private linkMode: "lan" | "wan" | null = null; // measured ICE path -> daemon watchdog
  private mode: ControlMode = "cylindrical";
  // When non-null, the jog tick sends this payload instead of the keyboard-derived one
  // (set by the VR session each frame; null = keyboard owns the stream). An all-zeros
  // payload is a deliberate "hold" (e.g. clutch released) — distinct from null.
  private externalJog: ExternalJog | null = null;
  private readonly pressed = new Set<string>();
  private readonly cmdDown = new Set<string>();
  // loop_hz / temp / status only ride the periodic telemetry block, not every per-tick
  // frame — keep last values so the readout doesn't flicker to 0.
  private tel: TelemetryView = {
    loopHz: 0, safety: "-", watchdog: "-", tempC: 0, active: false, linkMode: null, currents: {}, state: {},
  };
  private stopped = false;

  // ---- two-way call (Phase 7 §B) -------------------------------------------
  private micStream: MediaStream | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private camStream: MediaStream | null = null;
  private camTrack: MediaStreamTrack | null = null;
  private call: CallState = {
    active: false, micMuted: true, micSending: false,
    robotAudio: false, robotMicLive: false, cameraOn: false,
  };

  constructor(opts: RemoteTeleopOptions) {
    this.o = opts;
  }

  private log = (...a: unknown[]) => this.o.onLog(a.join(" "));

  setArm(arm: ArmSide) {
    this.o.arm = arm;
  }

  // VR (or any external input mapper) hands the jog tick a ready jog payload. Pass null
  // to release the stream back to the keyboard. The next jogTick uses it as-is.
  setExternalJog(jog: ExternalJog | null) {
    this.externalJog = jog;
  }

  // Public command surface for non-keyboard inputs (VR E-STOP / reset). Mirrors sendCmd.
  command(cmd: "estop" | "reset_latch" | "reset") {
    this.sendCmd(cmd);
  }

  // Flip cylindrical <-> per-motor from the UI (same effect as the 'm' key). onMode fires.
  toggleMode() {
    this.setMode(this.mode === "joint" ? "cylindrical" : "joint");
  }

  // ---- two-way call (Phase 7 §B) -------------------------------------------
  // All of the following are renegotiation-free (R-X.1): the operator's mic/camera are
  // attached to transceivers the robot offered up front via replaceTrack. If the robot has
  // not (yet) offered an audio/video uplink m-line, capture still succeeds locally but
  // micSending/cameraOn reflect that nothing is transmitted (Pi M3/M6 pending).

  callState(): CallState {
    return { ...this.call };
  }

  // Join the call: capture the mic (browser AEC/NS/AGC on as cheap insurance; the real fix
  // is robot-side hardware AEC, M3-D), wire it to the uplink if present, announce over the
  // control channel. Starts MUTED — the operator explicitly unmutes.
  async joinCall(): Promise<CallState> {
    if (!this.micStream) {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.micTrack = this.micStream.getAudioTracks()[0] ?? null;
    }
    if (this.micTrack) this.micTrack.enabled = !this.call.micMuted;
    this.call.active = true;
    this.applyAudioSink(); // now in the call -> unmute the robot audio sink
    const wired = this.attachTrack("audio", this.micTrack);
    this.call.micSending = wired && !this.call.micMuted;
    if (!wired) this.log("mic captured, but robot offered no audio uplink — not transmitting (Pi M3 pending)");
    this.dcSend({ type: "call", state: "join", mic_muted: this.call.micMuted });
    this.emitCall();
    return this.callState();
  }

  // Leave the call: stop capture, detach from the uplink, announce.
  leaveCall() {
    this.detachTrack("audio");
    this.stopStream(this.micStream); this.micStream = null; this.micTrack = null;
    this.disableCamera();
    this.call.active = false;
    this.call.micSending = false;
    this.applyAudioSink(); // left the call -> mute the robot audio sink again
    this.dcSend({ type: "call", state: "leave" });
    this.emitCall();
  }

  // Mute/unmute the operator mic. A track.enabled flip — never a renegotiation.
  setMicMuted(muted: boolean) {
    this.call.micMuted = muted;
    if (this.micTrack) this.micTrack.enabled = !muted;
    this.call.micSending = this.call.active && !muted && !!this.audioSender();
    this.dcSend({ type: "call", mic_muted: muted });
    this.emitCall();
  }

  // M6 (gated): capture the operator camera and wire it to the reserved video uplink. Built
  // now, shipped dark — the page only calls this behind isM6VideoEnabled(). Returns the local
  // stream so the caller can show a self-view.
  async enableCamera(): Promise<MediaStream | null> {
    if (!this.camStream) {
      this.camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 }, // ≤480p (R-X.7: a 7" DSI needs no more)
      });
      this.camTrack = this.camStream.getVideoTracks()[0] ?? null;
    }
    const wired = this.attachTrack("video", this.camTrack);
    this.call.cameraOn = true;
    if (!wired) this.log("camera captured, but robot offered no video uplink — not transmitting (Pi M6 pending)");
    this.emitCall();
    return this.camStream;
  }

  disableCamera() {
    this.detachTrack("video");
    this.stopStream(this.camStream); this.camStream = null; this.camTrack = null;
    this.call.cameraOn = false;
    this.emitCall();
  }

  private emitCall() {
    this.o.onCall?.({ ...this.call });
  }

  // Robot audio only plays while the operator is in the call (mute the sink otherwise), so
  // merely connecting the session never leaks room audio.
  private applyAudioSink() {
    if (this.o.audioEl) this.o.audioEl.muted = !this.call.active;
  }

  // Re-attach whatever the operator already captured onto the current peer (used after a
  // fresh peer is built mid-call). No-op if nothing captured.
  private attachLocalMedia() {
    if (this.micTrack) {
      const wired = this.attachTrack("audio", this.micTrack);
      this.call.micSending = wired && this.call.active && !this.call.micMuted;
    }
    if (this.camTrack) this.attachTrack("video", this.camTrack);
    this.emitCall();
  }

  // Find a transceiver of the given kind we can SEND on (the robot offered to receive from
  // us), and replaceTrack. Returns whether an uplink existed.
  private attachTrack(kind: "audio" | "video", track: MediaStreamTrack | null): boolean {
    if (!this.pc || !track) return false;
    const tr = this.sendTransceiver(kind);
    if (!tr) return false;
    try { tr.sender.replaceTrack(track); return true; } catch { return false; }
  }

  private detachTrack(kind: "audio" | "video") {
    const tr = this.pc ? this.sendTransceiver(kind) : null;
    try { tr?.sender.replaceTrack(null); } catch { /* peer already gone */ }
  }

  private audioSender(): boolean {
    return !!this.sendTransceiver("audio");
  }

  // The first transceiver of `kind` whose negotiated direction lets us send. Uses the
  // inbound receiver track's kind to identify the m-line's media type (reliable post-SRD).
  private sendTransceiver(kind: "audio" | "video"): RTCRtpTransceiver | null {
    if (!this.pc) return null;
    const canSend = (d: RTCRtpTransceiverDirection | null | undefined) =>
      d === "sendrecv" || d === "sendonly";
    for (const t of this.pc.getTransceivers()) {
      if (t.receiver.track?.kind !== kind) continue;
      if (canSend(t.currentDirection) || canSend(t.direction)) return t;
    }
    return null;
  }

  // True if the robot's offer invites our voice (audio m-line is sendrecv → the robot will
  // RECEIVE). We reserve the uplink only then; an M3a sendonly offer stays recvonly (no uplink).
  private offerWantsAudioUplink(sdp: string): boolean {
    let inAudio = false;
    for (const line of sdp.split(/\r?\n/)) {
      if (line.startsWith("m=")) inAudio = line.startsWith("m=audio");
      else if (inAudio && line.startsWith("a=sendrecv")) return true;
    }
    return false;
  }

  private stopStream(s: MediaStream | null) {
    s?.getTracks().forEach((t) => t.stop());
  }

  private iceServers(): RTCIceServer[] {
    const servers: RTCIceServer[] = [{ urls: this.o.stun }];
    if (this.o.turnUrls.length) {
      servers.push({ urls: this.o.turnUrls, username: this.o.turnUser, credential: this.o.turnCred });
    }
    return servers;
  }

  // ---- lifecycle -----------------------------------------------------------
  async start() {
    this.stopped = false;
    if (this.o.forceRelay && !this.o.turnUrls.length) {
      this.log("force relay is on but no TURN URL set — connect will fail");
    }
    this.log(
      `ICE: STUN${this.o.turnUrls.length ? ` + TURN(${this.o.turnUrls.length})` : ""}` +
        (this.o.forceRelay ? "  [FORCE RELAY]" : "")
    );

    // All SDP/ICE + the room handshake ride the injected SignalingTransport (Supabase in the
    // fork, BYO for external SDK consumers). The WebRTC/auth/jog logic below is transport-agnostic.
    await this.o.signaling.connect({
      // a fresh offer => a fresh peer connection (handles robot restarts / reconnects)
      onSdp: async (payload) => {
        if (!payload || payload.type !== "offer") return;
        this.log("offer received; building fresh peer + answering...");
        const pc = this.freshPeer();
        await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
        this.remoteSet = true;
        for (const c of this.pendingIce) {
          try { await pc.addIceCandidate(c); } catch (e) { this.log("ice warn", (e as Error).message); }
        }
        this.pendingIce = [];
        // Reserve the audio UPLINK before answering: the robot offers audio sendrecv (M3b), but a
        // browser answers RECVONLY by default (it only agreed to receive the robot mic). Flip our
        // audio transceiver to sendrecv now so the ANSWER advertises send — then joining the call
        // is a pure replaceTrack, never a renegotiation (R-X.1). Only when the robot actually
        // invites our voice, so the M3a sendonly path stays recvonly.
        if (this.offerWantsAudioUplink(payload.sdp)) {
          const at = pc.getTransceivers().find((t) => t.receiver.track?.kind === "audio");
          if (at && at.direction !== "sendrecv") {
            try { at.direction = "sendrecv"; this.log("reserved audio uplink (sendrecv) for the call"); }
            catch (e) { this.log("could not reserve audio uplink:", (e as Error).message); }
          }
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.o.signaling.sendSdp({ type: "answer", sdp: answer.sdp ?? "" });
        this.log("answer sent");
        // If a call was already joined before (re)connect, re-wire mic/cam onto this fresh
        // peer's transceivers. Pure replaceTrack — no renegotiation (R-X.1).
        this.attachLocalMedia();
      },

      onIce: async (payload) => {
        const cand = { candidate: payload.candidate, sdpMLineIndex: payload.sdpMLineIndex };
        if (this.pc && this.remoteSet) {
          try { await this.pc.addIceCandidate(cand); } catch (e) { this.log("ice warn", (e as Error).message); }
        } else {
          this.pendingIce.push(cand);
        }
      },

      // robot (re)joined -> it carries the auth nonce; prove we hold the token (HMAC),
      // then ask for a fresh offer. (No token configured on either side = open room.)
      onRobotHere: async (payload) => {
        this.connected = false;
        try {
          this.curMac =
            this.o.token && payload && payload.nonce ? await hmacHex(this.o.token, payload.nonce) : "";
        } catch (e) { this.log("auth error:", (e as Error).message); this.curMac = ""; }
        this.log("robot announced — sending 'ready'" + (this.curMac ? " (authenticated)" : ""));
        this.sendReady();
      },

      onOpen: () => {
        this.connected = false;
        this.sendReady();
        this.log("announced 'ready' — waiting for robot offer");
        if (this.retryTimer) clearInterval(this.retryTimer);
        this.retryTimer = setInterval(() => { if (!this.connected) this.sendReady(); }, 2000);
      },
    });

    if (!this.jogTimer) this.jogTimer = setInterval(() => this.jogTick(), JOG_HZ_MS);
  }

  async stop() {
    this.stopped = true;
    this.pressed.clear();
    // release mic/camera capture (safe if never joined)
    this.stopStream(this.micStream); this.micStream = null; this.micTrack = null;
    this.stopStream(this.camStream); this.camStream = null; this.camTrack = null;
    this.call = {
      active: false, micMuted: true, micSending: false,
      robotAudio: false, robotMicLive: false, cameraOn: false,
    };
    this.emitCall();
    if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
    if (this.jogTimer) { clearInterval(this.jogTimer); this.jogTimer = null; }
    this.latencyProbe?.stop();
    // tell the robot to exit (clean restart) before we tear down
    this.o.signaling.sendBye();
    if (this.pc) { try { this.pc.close(); } catch { /* noop */ } this.pc = null; }
    await this.o.signaling.close();
    this.controlCh = null;
    this.connected = false;
    this.tel.active = false;
    this.o.onTelemetry({ ...this.tel });
    this.o.onControlActive(false);
    this.o.onConnState("closed");
  }

  // On-demand audio-latency snapshot (R-X.2). Logs + returns the network+jitter-buffer breakdown;
  // null if there's no active peer yet. Also auto-runs every 3 s when the page URL has ?audiolatency.
  async logAudioLatency() {
    return this.latencyProbe ? this.latencyProbe.logOnce() : null;
  }

  private sendReady() {
    this.o.signaling.sendReady(this.curMac ? { mac: this.curMac } : {});
  }

  private freshPeer(): RTCPeerConnection {
    if (this.pc) { try { this.pc.close(); } catch { /* noop */ } }
    this.remoteSet = false;
    this.pendingIce = [];
    // A fresh peer renegotiates all media, so drop the old per-camera track routing.
    this.videoByMid.clear();
    this.camNameByMid.clear();
    this.primaryMid = null;
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers(),
      iceTransportPolicy: this.o.forceRelay ? "relay" : "all",
    });
    this.pc = pc;
    this.latencyProbe?.stop();
    this.latencyProbe = new AudioLatencyProbe(pc, (...a) => this.log(...a));
    this.linkMode = null; // recomputed per connection from the selected candidate pair
    this.tel.linkMode = null;
    pc.ontrack = (ev) => {
      // Robot inbound audio -> dedicated sink. Kept MUTED until the operator joins the call,
      // so connecting the session doesn't leak room audio before you're "in the call".
      if (ev.track.kind === "audio") {
        if (this.o.audioEl && this.o.audioEl.srcObject !== ev.streams[0]) {
          this.o.audioEl.srcObject = ev.streams[0];
          this.log("robot audio track attached" + (this.call.active ? "" : " (muted until Join call)"));
        }
        this.applyAudioSink();
        this.call.robotAudio = true;
        // If the robot mutes/ends its mic, drop the indicator.
        ev.track.onmute = () => { this.call.robotAudio = false; this.emitCall(); };
        ev.track.onended = () => { this.call.robotAudio = false; this.emitCall(); };
        this.emitCall();
        return;
      }
      // ---- video: one track per camera. Route each by its transceiver mid (stable id). ----
      const mid = ev.transceiver?.mid ?? `idx${this.videoByMid.size}`;
      const stream = ev.streams[0];
      this.videoByMid.set(mid, stream);
      // Primary feed (first video track) -> videoEl, so VR + single-camera clients are unchanged.
      if (this.primaryMid === null) {
        this.primaryMid = mid;
        if (this.o.videoEl.srcObject !== stream) this.o.videoEl.srcObject = stream;
        this.log("video track attached (primary)");
      } else {
        this.log(`video track attached (camera ${this.camNameByMid.get(mid) ?? mid})`);
      }
      // Per-camera routing for a multi-feed grid (no-op if the app didn't opt in).
      this.o.onVideoTrack?.(mid, stream);
      ev.track.onended = () => {
        this.videoByMid.delete(mid);
        this.o.onVideoRemoved?.(mid);
        if (this.primaryMid === mid) this.primaryMid = null; // let the next track become primary
      };
    };
    pc.ondatachannel = (ev) => this.setupControl(ev.channel); // robot opens 'control'
    pc.oniceconnectionstatechange = () => this.log("ice:", pc.iceConnectionState);
    pc.onconnectionstatechange = () => {
      this.log("conn:", pc.connectionState);
      this.o.onConnState(pc.connectionState);
      if (pc.connectionState === "connected") {
        this.connected = true;
        if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
        this.logSelectedPath();
        // Latency harness (R-X.2): with ?audiolatency, log the network+jitter-buffer breakdown
        // of the audio path every few seconds. Works on the M3a uplink today; reused for M3b.
        if (audioLatencyEnabled()) this.latencyProbe?.start();
      } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        this.connected = false; // robot will exit + restart; keep asking for a new offer
        this.latencyProbe?.stop();
        if (!this.retryTimer && !this.stopped) {
          this.retryTimer = setInterval(() => { if (!this.connected) this.sendReady(); }, 2000);
        }
      }
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.o.signaling.sendIce({
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
          candidate: ev.candidate.candidate,
        });
      }
    };
    return pc;
  }

  // report which ICE path won: host (LAN), srflx/prflx (STUN-direct), or relay (TURN).
  private async logSelectedPath() {
    if (!this.pc) return;
    try {
      const stats = await this.pc.getStats();
      let pair: RTCStats | undefined;
      stats.forEach((r) => {
        const x = r as RTCStats & { selected?: boolean; nominated?: boolean; state?: string };
        if (r.type === "candidate-pair" && x.selected) pair = r;
      });
      if (!pair) {
        stats.forEach((r) => {
          const x = r as RTCStats & { nominated?: boolean; state?: string };
          if (r.type === "candidate-pair" && x.state === "succeeded" && x.nominated) pair = r;
        });
      }
      if (!pair) return;
      const p = pair as RTCStats & { localCandidateId: string; remoteCandidateId: string };
      const local = stats.get(p.localCandidateId) as (RTCStats & { candidateType?: string }) | undefined;
      const remote = stats.get(p.remoteCandidateId) as (RTCStats & { candidateType?: string }) | undefined;
      const t = (c?: { candidateType?: string }) => (c ? c.candidateType : "?");
      const relayed = t(local) === "relay" || t(remote) === "relay";
      this.log(
        `ICE path: local=${t(local)} remote=${t(remote)}` +
          (relayed ? "  *** via TURN relay ***" : "  (direct)")
      );
      // Both candidates 'host' => direct same-subnet LAN; anything else (srflx via
      // STUN, relay via TURN) is WAN. Tell the daemon so it uses the matching watchdog
      // profile (LAN 150/500 vs WAN 300/1000) instead of always assuming WAN.
      this.linkMode = t(local) === "host" && t(remote) === "host" ? "lan" : "wan";
      this.tel.linkMode = this.linkMode;
      this.o.onTelemetry({ ...this.tel }); // surface the link chip as soon as the path resolves
      this.sendLink();
    } catch { /* getStats best-effort */ }
  }

  // Tell the robot the measured link path. Sent both here (when the pair resolves) and
  // on control-channel open, since their ordering isn't guaranteed.
  private sendLink() {
    if (!this.linkMode) return;
    if (this.controlCh && this.controlCh.readyState === "open") {
      this.dcSend({ type: "link", mode: this.linkMode });
      this.log("link -> " + this.linkMode + " (daemon watchdog follows ICE path)");
    }
  }

  // ---- control data channel ------------------------------------------------
  private setupControl(ch: RTCDataChannel) {
    this.controlCh = ch;
    ch.onopen = () => {
      this.log("control channel open — keyboard active");
      this.tel.active = true;
      this.o.onControlActive(true);
      this.sendLink(); // path may have resolved before the channel opened
    };
    ch.onclose = () => {
      if (this.controlCh === ch) this.controlCh = null;
      this.tel.active = false;
      this.o.onControlActive(false);
    };
    ch.onmessage = (e) => this.handleTelemetry(e.data);
  }

  private handleTelemetry(data: string) {
    let m: Record<string, unknown>;
    try { m = JSON.parse(data); } catch { return; }
    if (m.type === "telemetry") {
      if (typeof m.loop_hz === "number") this.tel.loopHz = m.loop_hz;
      if (typeof m.pi_temp_c === "number" && m.pi_temp_c > 0) this.tel.tempC = m.pi_temp_c;
      const status = m.status as { safety?: string; watchdog?: string } | undefined;
      if (status) {
        if (status.safety) this.tel.safety = status.safety;
        if (status.watchdog) this.tel.watchdog = status.watchdog;
      }
      // Per-motor Present_Current (virtual tactile signal) -> VR haptics + on-screen readout.
      if (m.currents && typeof m.currents === "object") {
        this.tel.currents = m.currents as Record<string, number>;
        this.o.onCurrents?.(this.tel.currents);
      }
      // lerobot-native `state` dict (every "<motor>.pos" + base "x.vel"/"theta.vel").
      // Carried through so a 3D pose view (C6) can run FK off the joint angles.
      if (m.state && typeof m.state === "object") {
        this.tel.state = m.state as Record<string, number>;
      }
      // Reserved: robot reports whether its mic is live (Pi M3). Drives the "robot on air"
      // indicator; absent until the daemon sends it.
      if (typeof m.robot_mic_live === "boolean" && m.robot_mic_live !== this.call.robotMicLive) {
        this.call.robotMicLive = m.robot_mic_live;
        this.emitCall();
      }
      this.o.onTelemetry({ ...this.tel });
    } else if (m.type === "video_map") {
      // Robot maps each video m-line (by transceiver mid) to a camera name. May arrive before
      // or after the tracks themselves; the app relabels its tiles from onCameraNames.
      const cams = Array.isArray(m.cameras) ? m.cameras : [];
      for (const c of cams) {
        const cc = c as { mid?: unknown; name?: unknown };
        if (cc && cc.mid != null && typeof cc.name === "string") {
          this.camNameByMid.set(String(cc.mid), cc.name);
        }
      }
      this.o.onCameraNames?.(Object.fromEntries(this.camNameByMid));
      this.log("video_map: " + JSON.stringify(Object.fromEntries(this.camNameByMid)));
    } else if (m.type === "ack") {
      this.log("daemon ack (watchdog=" + JSON.stringify(m.watchdog_profile || m.watchdog || "?") + ")");
    } else if (m.type === "error") {
      this.log("daemon error: " + JSON.stringify(m));
    }
  }

  private dcSend(obj: unknown) {
    if (this.controlCh && this.controlCh.readyState === "open") {
      this.controlCh.send(JSON.stringify(obj));
    }
  }

  private armKeymap() {
    return this.mode === "joint" ? JOINT_KEYS : TASK_KEYS;
  }

  private setMode(m: ControlMode) {
    this.mode = m;
    this.pressed.clear();
    this.o.onMode(m);
    this.log("control mode: " + (m === "joint" ? "per-motor" : "cylindrical (rpi4)"));
  }

  private sendCmd(cmd: string) {
    this.pressed.clear(); // don't let a held key fight the command
    const armKey = `${this.o.arm}_arm`;
    if (cmd === "reset") this.dcSend({ type: "control", reset: { [armKey]: true } });
    else this.dcSend({ type: "command", [cmd]: true });
    this.log("cmd: " + cmd);
  }

  // ---- keyboard (called by the page's window listeners) --------------------
  onKeyDown(e: KeyboardEvent): boolean {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return false;
    const k = e.key === " " ? " " : e.key.toLowerCase();
    if (k === "m") {
      if (!this.cmdDown.has("m")) {
        this.cmdDown.add("m");
        this.setMode(this.mode === "joint" ? "cylindrical" : "joint");
      }
      return true;
    }
    if (k in CMD_KEYS) {
      if (!this.cmdDown.has(k)) { this.cmdDown.add(k); this.sendCmd(CMD_KEYS[k]); }
      return true;
    }
    if (k in this.armKeymap() || k in BASE_KEYS || k in ZLIFT_KEYS) {
      this.pressed.add(k);
      return true;
    }
    return false;
  }

  onKeyUp(e: KeyboardEvent) {
    const k = e.key === " " ? " " : e.key.toLowerCase();
    this.pressed.delete(k);
    this.cmdDown.delete(k);
  }

  // 50 Hz level jog stream from the held-key set (daemon is level-triggered)
  private jogTick() {
    const ch = this.controlCh;
    if (!ch || ch.readyState !== "open") return;
    if (ch.bufferedAmount > BUFFER_LIMIT) return; // congested -> skip, don't pile up latency

    // VR (or another mapper) owns the stream: send its payload verbatim. It already
    // carries left_arm/right_arm/base/left_lift/right_lift in the daemon's jog vocabulary, so this is
    // the identical wire frame the keyboard path below produces — just a different source.
    if (this.externalJog) {
      this.dcSend({ type: "control", jog: this.externalJog });
      return;
    }

    const km = this.armKeymap();
    // joint mode: always send all 6 joint fields (0 default) so the daemon picks the
    // per-motor path. cylindrical mode: send only task DOFs -> daemon task/IK path.
    const a: Record<string, number> =
      this.mode === "joint"
        ? { shoulder_pan: 0, shoulder_lift: 0, elbow_flex: 0, wrist_flex: 0, wrist_roll: 0, gripper: 0 }
        : {};
    const base: Record<string, number> = {};
    let z = 0;
    for (const k of this.pressed) {
      if (k in km) { const [d, s] = km[k]; a[d] = s; }
      else if (k in BASE_KEYS) { const [dof, s] = BASE_KEYS[k]; base[dof] = s; }
      else if (k in ZLIFT_KEYS) z = ZLIFT_KEYS[k];
    }
    const jog: Record<string, unknown> = { [`${this.o.arm}_arm`]: a };
    if (Object.keys(base).length) jog.base = base;
    // u/o lift the CURRENTLY SELECTED arm (the dropdown that scopes the arm keys).
    if (z) jog[`${this.o.arm}_lift`] = z;
    this.dcSend({ type: "control", jog });
  }
}
