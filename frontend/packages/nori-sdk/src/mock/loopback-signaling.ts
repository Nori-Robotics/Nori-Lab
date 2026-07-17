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

  // Every delivery is deferred and dropped once the room is closed — mirrors a real transport
  // where a message can't arrive after unsubscribe.
  const deliver = (fn: () => void) => {
    setTimeout(() => {
      if (!closed) fn();
    }, latency);
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
