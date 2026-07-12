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
  RobotHerePayload,
} from "./signaling";

export class SupabaseSignaling implements SignalingTransport {
  private channel: RealtimeChannel | null = null;

  // `log` is optional so the core stays logger-agnostic; the fork passes its appendLog so the
  // familiar "channel: SUBSCRIBED" trace survives the extraction.
  constructor(
    private supabase: SupabaseClient,
    private room: string,
    private log?: (...args: unknown[]) => void
  ) {}

  async connect(h: SignalingHandlers): Promise<void> {
    if (this.channel) { try { await this.channel.unsubscribe(); } catch { /* noop */ } }
    const channel = this.supabase.channel(this.room, { config: { broadcast: { self: false } } });
    this.channel = channel;

    channel.on("broadcast", { event: "sdp" }, ({ payload }) => h.onSdp(payload as SdpPayload));
    channel.on("broadcast", { event: "ice" }, ({ payload }) => h.onIce(payload as IcePayload));
    channel.on("broadcast", { event: "robot_here" }, ({ payload }) =>
      h.onRobotHere((payload ?? {}) as RobotHerePayload)
    );
    channel.subscribe((status) => {
      this.log?.("channel:", status);
      if (status === "SUBSCRIBED") h.onOpen();
      // Supabase reports its non-open states only through this callback; they used to be a log
      // line and nothing else, so an unreachable signaling service was invisible to the UI.
      // supabase-js keeps retrying underneath, so these are reported, not fatal.
      if (status === "CHANNEL_ERROR") h.onState?.("error");
      else if (status === "TIMED_OUT") h.onState?.("timeout");
      else if (status === "CLOSED") h.onState?.("closed");
      else if (status === "SUBSCRIBED") h.onState?.("open");
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
