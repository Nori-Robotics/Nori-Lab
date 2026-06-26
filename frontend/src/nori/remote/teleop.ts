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

import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

export type ControlMode = "cylindrical" | "joint";
export type ArmSide = "left" | "right";

export interface TelemetryView {
  loopHz: number;
  safety: string;
  watchdog: string;
  tempC: number;
  active: boolean;
}

export interface RemoteTeleopOptions {
  supabase: SupabaseClient;
  videoEl: HTMLVideoElement;
  room: string;
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
}

// Two schemes; 'm' toggles. Default = CYLINDRICAL (the rpi4 feel).
//  cylindrical: shoulder_pan + x/y reach (IK) + pitch + wrist_roll + gripper
//  joint (per-motor): each motor direct, top row +, bottom row -
const TASK_KEYS: Record<string, [string, number]> = {
  q: ["shoulder_pan", 1], e: ["shoulder_pan", -1],
  w: ["x", 1], s: ["x", -1], a: ["y", 1], d: ["y", -1],
  z: ["pitch", 1], x: ["pitch", -1], r: ["wrist_roll", 1], f: ["wrist_roll", -1],
  t: ["gripper", 1], g: ["gripper", -1],
};
const JOINT_KEYS: Record<string, [string, number]> = {
  q: ["shoulder_pan", 1], a: ["shoulder_pan", -1],
  w: ["shoulder_lift", 1], s: ["shoulder_lift", -1],
  e: ["elbow_flex", 1], d: ["elbow_flex", -1],
  r: ["wrist_flex", 1], f: ["wrist_flex", -1],
  t: ["wrist_roll", 1], g: ["wrist_roll", -1],
  y: ["gripper", 1], h: ["gripper", -1],
};
const BASE_KEYS: Record<string, [string, number]> = {
  i: ["linear", 1], k: ["linear", -1], j: ["angular", 1], l: ["angular", -1],
};
const ZLIFT_KEYS: Record<string, number> = { u: 1, o: -1 };
const CMD_KEYS: Record<string, string> = { " ": "estop", p: "reset_latch", c: "reset" };

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
  private channel: RealtimeChannel | null = null;
  private pc: RTCPeerConnection | null = null;
  private remoteSet = false;
  private pendingIce: RTCIceCandidateInit[] = [];
  private connected = false;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private jogTimer: ReturnType<typeof setInterval> | null = null;
  private controlCh: RTCDataChannel | null = null;
  private curMac = ""; // HMAC of the robot's nonce, proving we hold the token
  private linkMode: "lan" | "wan" | null = null; // measured ICE path -> daemon watchdog
  private mode: ControlMode = "cylindrical";
  private readonly pressed = new Set<string>();
  private readonly cmdDown = new Set<string>();
  // loop_hz / temp / status only ride the periodic telemetry block, not every per-tick
  // frame — keep last values so the readout doesn't flicker to 0.
  private tel: TelemetryView = { loopHz: 0, safety: "-", watchdog: "-", tempC: 0, active: false };
  private stopped = false;

  constructor(opts: RemoteTeleopOptions) {
    this.o = opts;
  }

  private log = (...a: unknown[]) => this.o.onLog(a.join(" "));

  setArm(arm: ArmSide) {
    this.o.arm = arm;
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
    const supabase = this.o.supabase;
    if (this.o.forceRelay && !this.o.turnUrls.length) {
      this.log("force relay is on but no TURN URL set — connect will fail");
    }
    this.log(
      `ICE: STUN${this.o.turnUrls.length ? ` + TURN(${this.o.turnUrls.length})` : ""}` +
        (this.o.forceRelay ? "  [FORCE RELAY]" : "")
    );

    if (this.channel) { try { await this.channel.unsubscribe(); } catch { /* noop */ } }
    const channel = supabase.channel(this.o.room, { config: { broadcast: { self: false } } });
    this.channel = channel;

    // a fresh offer => a fresh peer connection (handles robot restarts / reconnects)
    channel.on("broadcast", { event: "sdp" }, async ({ payload }) => {
      if (!payload || payload.type !== "offer") return;
      this.log("offer received; building fresh peer + answering...");
      const pc = this.freshPeer();
      await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      this.remoteSet = true;
      for (const c of this.pendingIce) {
        try { await pc.addIceCandidate(c); } catch (e) { this.log("ice warn", (e as Error).message); }
      }
      this.pendingIce = [];
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      channel.send({ type: "broadcast", event: "sdp", payload: { type: "answer", sdp: answer.sdp } });
      this.log("answer sent");
    });

    channel.on("broadcast", { event: "ice" }, async ({ payload }) => {
      const cand = { candidate: payload.candidate, sdpMLineIndex: payload.sdpMLineIndex };
      if (this.pc && this.remoteSet) {
        try { await this.pc.addIceCandidate(cand); } catch (e) { this.log("ice warn", (e as Error).message); }
      } else {
        this.pendingIce.push(cand);
      }
    });

    // robot (re)joined -> it carries the auth nonce; prove we hold the token (HMAC),
    // then ask for a fresh offer. (No token configured on either side = open room.)
    channel.on("broadcast", { event: "robot_here" }, async ({ payload }) => {
      this.connected = false;
      try {
        this.curMac =
          this.o.token && payload && payload.nonce ? await hmacHex(this.o.token, payload.nonce) : "";
      } catch (e) { this.log("auth error:", (e as Error).message); this.curMac = ""; }
      this.log("robot announced — sending 'ready'" + (this.curMac ? " (authenticated)" : ""));
      this.sendReady();
    });

    channel.subscribe((status) => {
      this.log("channel:", status);
      if (status === "SUBSCRIBED") {
        this.connected = false;
        this.sendReady();
        this.log("announced 'ready' — waiting for robot offer");
        if (this.retryTimer) clearInterval(this.retryTimer);
        this.retryTimer = setInterval(() => { if (!this.connected) this.sendReady(); }, 2000);
      }
    });

    if (!this.jogTimer) this.jogTimer = setInterval(() => this.jogTick(), JOG_HZ_MS);
  }

  async stop() {
    this.stopped = true;
    this.pressed.clear();
    if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
    if (this.jogTimer) { clearInterval(this.jogTimer); this.jogTimer = null; }
    // tell the robot to exit (clean restart) before we tear down
    try { this.channel?.send({ type: "broadcast", event: "bye", payload: {} }); } catch { /* noop */ }
    if (this.pc) { try { this.pc.close(); } catch { /* noop */ } this.pc = null; }
    if (this.channel) { try { await this.channel.unsubscribe(); } catch { /* noop */ } this.channel = null; }
    this.controlCh = null;
    this.connected = false;
    this.tel.active = false;
    this.o.onTelemetry({ ...this.tel });
    this.o.onControlActive(false);
    this.o.onConnState("closed");
  }

  private sendReady() {
    if (this.channel) {
      this.channel.send({
        type: "broadcast",
        event: "ready",
        payload: this.curMac ? { mac: this.curMac } : {},
      });
    }
  }

  private freshPeer(): RTCPeerConnection {
    if (this.pc) { try { this.pc.close(); } catch { /* noop */ } }
    this.remoteSet = false;
    this.pendingIce = [];
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers(),
      iceTransportPolicy: this.o.forceRelay ? "relay" : "all",
    });
    this.pc = pc;
    this.linkMode = null; // recomputed per connection from the selected candidate pair
    pc.ontrack = (ev) => {
      if (this.o.videoEl.srcObject !== ev.streams[0]) {
        this.o.videoEl.srcObject = ev.streams[0];
        this.log("video track attached");
      }
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
      } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        this.connected = false; // robot will exit + restart; keep asking for a new offer
        if (!this.retryTimer && !this.stopped) {
          this.retryTimer = setInterval(() => { if (!this.connected) this.sendReady(); }, 2000);
        }
      }
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate && this.channel) {
        this.channel.send({
          type: "broadcast",
          event: "ice",
          payload: { sdpMLineIndex: ev.candidate.sdpMLineIndex, candidate: ev.candidate.candidate },
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
      this.o.onTelemetry({ ...this.tel });
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
    if (z) jog.z_lift = z;
    this.dcSend({ type: "control", jog });
  }
}
