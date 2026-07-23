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
  // Signaling Phase 1. `private: true` joins make the room RLS-gated: the app's
  // signed-in Supabase session (supabase-js auto-pushes + refreshes its JWT) must be
  // the robot's paired customer to enter. `usePrivate` comes straight from opts.private
  // and NEVER changes: a rejected private join is TERMINAL (onState("error")), not a
  // silent downgrade.
  //
  // The old code fell back to a PUBLIC join on the first CHANNEL_ERROR to reach
  // un-migrated robots — but an RLS *denial* is indistinguishable from an un-migrated
  // robot at this layer, so that fallback dropped a non-paired user straight onto the
  // victim's public room, nullifying the whole RLS gate (audit C1). Removed: the fleet
  // is private-only now. A dev who needs a public room (e.g. `nori-dev`) passes
  // opts.private=false explicitly (flags.ts nori_private_room="0") — an intentional
  // public join, never an automatic escape hatch from a failed private one.
  private usePrivate = false;

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
    this.usePrivate = this.opts.private === true;
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
        // TERMINAL — no private->public downgrade. On a private join this is usually the
        // RLS gate refusing a caller who isn't the robot's paired customer; silently
        // re-joining public would drop them onto the room anyway and defeat the gate
        // (audit C1). A genuine un-migrated/public robot is reached by an explicit
        // opts.private=false join, not by failing a private one. supabase-js keeps
        // retrying the socket underneath, so a transient blip still recovers.
        this.log?.("channel error", this.usePrivate ? "(private — not paired / not signed in?)" : "(public)", err);
        h.onState?.("error");
      } else if (status === "TIMED_OUT") h.onState?.("timeout");
      else if (status === "CLOSED") h.onState?.("closed");
    });
  }

  sendReady(payload: { mac?: string; turn?: import("./signaling").ReadyTurn }): void {
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
