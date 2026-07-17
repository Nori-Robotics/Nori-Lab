// NORI: Additive file (SDK v1 mock mode — docs/sdk_v1_finalization.md item 1).
// In-memory SignalingTransport pair: the operator end plugs into RemoteTeleop unchanged; the
// robot end is consumed by MockRobot. No network, no Supabase — the same five-event contract
// (ready / robot_here / sdp / ice / bye) delivered over queued callbacks, with an optional
// artificial latency so reconnect/race paths can be exercised deterministically.
//
// SAFETY NOTE: signaling carries no control authority (see signaling.ts) — and in mock mode
// there is no robot at all, so this file is test scaffolding by construction.

import type {
  IcePayload,
  NackPayload,
  RobotHerePayload,
  SdpPayload,
  SignalingHandlers,
  SignalingTransport,
} from "../signaling";

// The robot half of the loopback room — the mirror image of SignalingTransport. MockRobot
// registers callbacks once; re-registering replaces (one robot per room, like the real thing).
export interface MockRobotSignalingPort {
  // robot -> operator
  announce(payload?: RobotHerePayload): void;
  sendSdp(p: SdpPayload): void;
  sendIce(p: IcePayload): void;
  sendNack(p: NackPayload): void;
  // operator -> robot
  onOperatorOpen(cb: () => void): void;
  onReady(cb: (p: { mac?: string }) => void): void;
  onSdp(cb: (p: SdpPayload) => void): void;
  onIce(cb: (p: IcePayload) => void): void;
  onBye(cb: () => void): void;
}

export interface LoopbackSignalingOptions {
  // Per-message one-way delivery delay. 0 (default) still delivers asynchronously (queued
  // macrotask) so ordering matches a real transport — never synchronously re-entrant.
  latencyMs?: number;
}

export function createLoopbackSignaling(opts?: LoopbackSignalingOptions): {
  transport: SignalingTransport;
  robot: MockRobotSignalingPort;
} {
  const latency = Math.max(0, opts?.latencyMs ?? 0);
  let operator: SignalingHandlers | null = null;
  let closed = false;

  const robotCbs: {
    open?: () => void;
    ready?: (p: { mac?: string }) => void;
    sdp?: (p: SdpPayload) => void;
    ice?: (p: IcePayload) => void;
    bye?: () => void;
  } = {};

  // Every delivery is deferred (queued macrotask) so ordering matches a real transport and a
  // send is never synchronously re-entrant.
  //
  // `closed` is checked at SEND time, not delivery time: a message handed to the transport
  // while the room was still open is already on its way and must still land. RemoteTeleop.stop()
  // relies on exactly this — it calls sendBye() and close() in the same synchronous task
  // (teleop.ts stop()), so a delivery-time check would drop every bye and the robot would never
  // hear the operator leave. Sends made AFTER close are dropped, like a real unsubscribe.
  const deliver = (fn: () => void) => {
    if (closed) return;
    setTimeout(fn, latency);
  };

  const transport: SignalingTransport = {
    async connect(handlers: SignalingHandlers) {
      operator = handlers;
      closed = false;
      deliver(() => {
        operator?.onState?.("open");
        operator?.onOpen();
        robotCbs.open?.();
      });
    },
    sendReady(payload: { mac?: string }) {
      deliver(() => robotCbs.ready?.(payload ?? {}));
    },
    sendSdp(payload: SdpPayload) {
      deliver(() => robotCbs.sdp?.(payload));
    },
    sendIce(payload: IcePayload) {
      deliver(() => robotCbs.ice?.(payload));
    },
    sendBye() {
      deliver(() => robotCbs.bye?.());
    },
    async close() {
      closed = true;
      operator = null;
    },
  };

  const robot: MockRobotSignalingPort = {
    announce(payload?: RobotHerePayload) {
      deliver(() => operator?.onRobotHere(payload ?? {}));
    },
    sendSdp(p: SdpPayload) {
      deliver(() => operator?.onSdp(p));
    },
    sendIce(p: IcePayload) {
      deliver(() => operator?.onIce(p));
    },
    sendNack(p: NackPayload) {
      deliver(() => operator?.onNack?.(p));
    },
    onOperatorOpen(cb) {
      robotCbs.open = cb;
    },
    onReady(cb) {
      robotCbs.ready = cb;
    },
    onSdp(cb) {
      robotCbs.sdp = cb;
    },
    onIce(cb) {
      robotCbs.ice = cb;
    },
    onBye(cb) {
      robotCbs.bye = cb;
    },
  };

  return { transport, robot };
}
