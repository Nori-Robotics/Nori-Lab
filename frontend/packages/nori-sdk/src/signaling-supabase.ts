// NORI: Additive file (SDK Phase 0). Supabase Realtime implementation of SignalingTransport —
// the transport the LeLab fork ships with. This is the ONLY file in the SDK core that imports
// Supabase; keeping the coupling here is the whole point (see signaling.ts + docs/SDK_TODOS.md).
// An external SDK consumer who doesn't use Supabase provides their own SignalingTransport and
// never imports this file.
//
// The channel calls below are a VERBATIM lift of what used to live inline in teleop.ts's
// start()/stop()/sendReady()/freshPeer(), so behavior for the fork is byte-identical.

import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type {
  SignalingTransport,
  SignalingHandlers,
  SdpPayload,
  IcePayload,
  NackPayload,
  RobotHerePayload,
} from "./signaling";

export class SupabaseSignaling implements SignalingTransport {
  private channel: RealtimeChannel | null = null;
  private handlers: SignalingHandlers | null = null;
  // Signaling Phase 1 (1e). `private: true` joins make the room RLS-gated: the app's
  // signed-in Supabase session (supabase-js auto-pushes + refreshes its JWT) must be
  // the robot's paired customer to enter. `usePrivate` starts from opts.private and
  // DROPS to false once, as a migration fallback (see openChannel), so an updated app
  // still reaches not-yet-migrated robots + open dev rooms. Off by default → today's
  // public join, byte-for-byte, until the app flips the flag.
  private usePrivate = false;
  private triedPublicFallback = false;

  // `log` is optional so the core stays logger-agnostic; the fork passes its appendLog so the
  // familiar "channel: SUBSCRIBED" trace survives the extraction.
  constructor(
    private supabase: SupabaseClient,
    private room: string,
    private log?: (...args: unknown[]) => void,
    private opts: { private?: boolean } = {}
  ) {}

  async connect(h: SignalingHandlers): Promise<void> {
    this.handlers = h;
    // Reset per connect(): each fresh session tries private again (the robot may have
    // been provisioned/flipped since the last attempt).
    this.usePrivate = this.opts.private === true;
    this.triedPublicFallback = false;
    await this.openChannel();
  }

  private async openChannel(): Promise<void> {
    const h = this.handlers;
    if (!h) return;
    if (this.channel) { try { await this.channel.unsubscribe(); } catch { /* noop */ } }
    const channel = this.supabase.channel(this.room, {
      config: { private: this.usePrivate, broadcast: { self: false } },
    });
    this.channel = channel;

    channel.on("broadcast", { event: "sdp" }, ({ payload }) => h.onSdp(payload as SdpPayload));
    channel.on("broadcast", { event: "ice" }, ({ payload }) => h.onIce(payload as IcePayload));
    channel.on("broadcast", { event: "robot_here" }, ({ payload }) =>
      h.onRobotHere((payload ?? {}) as RobotHerePayload)
    );
    channel.on("broadcast", { event: "nack" }, ({ payload }) =>
      h.onNack?.((payload ?? {}) as NackPayload)
    );
    channel.subscribe((status, err) => {
      this.log?.("channel:", status, this.usePrivate ? "(private)" : "(public)");
      if (status === "SUBSCRIBED") { h.onOpen(); h.onState?.("open"); return; }
      // Supabase reports its non-open states only through this callback; they used to be a log
      // line and nothing else, so an unreachable signaling service was invisible to the UI.
      // supabase-js keeps retrying underneath, so these are reported, not fatal.
      if (status === "CHANNEL_ERROR") {
        // Migration fallback: a private join can fail because the robot isn't
        // provisioned/paired yet (RLS denies), or the operator isn't signed in. Retry
        // ONCE as a public channel so an updated app still reaches un-migrated robots
        // and dev rooms. Remove once the whole fleet is private.
        if (this.usePrivate && !this.triedPublicFallback) {
          this.triedPublicFallback = true;
          this.usePrivate = false;
          this.log?.("private room join failed — retrying public (un-migrated robot or signed-out?)", err);
          void this.openChannel();
          return;
        }
        h.onState?.("error");
      } else if (status === "TIMED_OUT") h.onState?.("timeout");
      else if (status === "CLOSED") h.onState?.("closed");
    });
  }

  sendReady(payload: { mac?: string }): void {
    this.channel?.send({ type: "broadcast", event: "ready", payload });
  }

  sendSdp(payload: SdpPayload): void {
    this.channel?.send({ type: "broadcast", event: "sdp", payload });
  }

  sendIce(payload: IcePayload): void {
    this.channel?.send({ type: "broadcast", event: "ice", payload });
  }

  sendBye(): void {
    try { this.channel?.send({ type: "broadcast", event: "bye", payload: {} }); } catch { /* noop */ }
  }

  async close(): Promise<void> {
    if (this.channel) {
      try { await this.channel.unsubscribe(); } catch { /* noop */ }
      this.channel = null;
    }
  }
}
