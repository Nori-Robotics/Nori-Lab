// NORI: Additive file (SDK Phase 0). Transport abstraction for the teleop SIGNALING channel —
// the small out-of-band pipe that carries WebRTC SDP/ICE + the room handshake between the
// operator and the robot BEFORE the peer connection exists.
//
// WHY THIS EXISTS: RemoteTeleop used to call Supabase Realtime directly, which welded the whole
// SDK to Nori's cloud — an external dev would need a Supabase seat just to exchange an offer.
// The surface actually used is tiny (a broadcast room with a handful of named events), so we
// hide it behind this interface. The fork ships a Supabase adapter (signaling-supabase.ts); an
// external SDK consumer can bring their own transport (a plain WebSocket, a manual copy/paste,
// a different SaaS) without touching RemoteTeleop. This is the keystone that makes nori-sdk
// cloud-agnostic (see docs/SDK_TODOS.md, Phase 0).
//
// SAFETY NOTE: the transport carries only signaling. The daemon defends itself regardless
// (clamp / watchdog / E-STOP / torque lifecycle are all Pi-side), so a buggy or hostile
// signaling implementation can at worst fail to connect — it can never move the robot unsafely.

// Payloads are the exact JSON shapes the Pi's webrtc_robot.py exchanges. Do NOT reshape these
// without bumping the wire contract on BOTH ends.
export interface SdpPayload {
  type: "offer" | "answer";
  sdp: string;
}
export interface IcePayload {
  candidate: string;
  sdpMLineIndex: number | null;
}
export interface RobotHerePayload {
  nonce?: string;
}

// The robot REFUSED our 'ready'. `reason` names why (e.g. the robot is busy with another
// session). Room-token auth is retired — the robot gates private-room access itself via
// Supabase RLS — so the operator no longer computes an HMAC and a legacy "unauthorized" nack
// is treated as a stray/forged artifact rather than a wrong access code.
//
// TRUST: the signaling room's membership is enforced by the robot (RLS), but a nack itself can
// be forged by anyone already in the room. It is a HINT used only to pick better error copy —
// never a security decision.
export interface NackPayload {
  reason?: "unauthorized" | (string & {});
}

// Transport health, as distinct from robot health. "open" = the room is live and we can speak;
// "error"/"timeout" = we cannot reach the signaling service at all (down, offline, bad URL).
// Without this the operator cannot tell "my internet is broken" from "my robot is off" — both
// used to look like an unbounded silent wait.
export type SignalingState = "open" | "error" | "timeout" | "closed";

// Inbound events RemoteTeleop reacts to. Registered once, when connect() is called.
export interface SignalingHandlers {
  // The robot published an SDP OFFER (the operator is always the answerer, so only offers
  // arrive here). RemoteTeleop builds a fresh peer and answers.
  onSdp: (payload: SdpPayload) => void;
  // A remote ICE candidate from the robot.
  onIce: (payload: IcePayload) => void;
  // The robot (re)joined the room — re-announce 'ready' and re-handshake. (The robot may still
  // carry a legacy nonce; the operator no longer uses it, since room-token auth is retired.)
  // May fire repeatedly (robot restarts / reconnects).
  onRobotHere: (payload: RobotHerePayload) => void;
  // The robot rejected our 'ready' (see NackPayload). Optional: robots older than 2026-07-12
  // never send it, so its ABSENCE must never be read as success.
  onNack?: (payload: NackPayload) => void;
  // The transport is live (e.g. Supabase "SUBSCRIBED") — safe to announce 'ready'. May fire
  // more than once across a session's reconnects; RemoteTeleop is idempotent on it.
  onOpen: () => void;
  // Optional: every transport state change, including the failures onOpen can't express. A
  // transport that can't distinguish these may simply never call it (RemoteTeleop then behaves
  // exactly as before). Implementations should still call onOpen on "open" for compatibility.
  onState?: (state: SignalingState) => void;
}

// The operator side of the signaling room. One instance per teleop session. RemoteTeleop owns
// its lifecycle: connect() on start(), close() on stop().
export interface SignalingTransport {
  // Join the room and wire the inbound handlers. Resolves once wiring is registered — NOT once
  // the room is open; readiness is signalled via handlers.onOpen (which may fire repeatedly).
  connect(handlers: SignalingHandlers): Promise<void>;
  // Announce the operator is 'ready'. The `mac` field is legacy (room-token HMAC proof) and is
  // no longer sent by the operator — kept optional so a mock robot can still exercise it.
  sendReady(payload: { mac?: string }): void;
  // Publish our SDP ANSWER back to the robot.
  sendSdp(payload: SdpPayload): void;
  // Publish one local ICE candidate to the robot.
  sendIce(payload: IcePayload): void;
  // Best-effort "operator leaving" so the robot restarts cleanly. MUST NOT throw.
  sendBye(): void;
  // Tear down the room subscription. Idempotent.
  close(): Promise<void>;
}
