// Tests for the SDK Supabase signaling transport's private-room join (Signaling
// Phase 1). A private join is either explicit-public (opts.private=false) or
// private-and-terminal-on-error: there is NO private->public downgrade (audit C1).
import { describe, it, expect, vi } from "vitest";
import { SupabaseSignaling } from "@nori/sdk/supabase";

type SubCb = (status: string, err?: unknown) => void;

class FakeChannel {
  subCb: SubCb | null = null;
  unsubscribed = false;
  constructor(public topic: string, public opts: { config?: { private?: boolean } }) {}
  on() { return this; }
  subscribe(cb: SubCb) { this.subCb = cb; return this; }
  async unsubscribe() { this.unsubscribed = true; return "ok"; }
  emit(status: string, err?: unknown) { this.subCb?.(status, err); }
  get isPrivate() { return this.opts.config?.private; }
}

class FakeSupabase {
  channels: FakeChannel[] = [];
  channel(topic: string, opts: { config?: { private?: boolean } }) {
    const c = new FakeChannel(topic, opts);
    this.channels.push(c);
    return c as unknown as ReturnType<typeof this.channel>;
  }
}

function handlers() {
  return {
    onSdp: vi.fn(), onIce: vi.fn(), onRobotHere: vi.fn(), onNack: vi.fn(),
    onOpen: vi.fn(), onState: vi.fn(),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("SupabaseSignaling private rooms (1e)", () => {
  it("joins public by default (flag off) — no private flag, no fallback", async () => {
    const sb = new FakeSupabase();
    const h = handlers();
    const sig = new SupabaseSignaling(sb as never, "Nori-L2-1", undefined, { private: false });
    await sig.connect(h);
    expect(sb.channels).toHaveLength(1);
    expect(sb.channels[0].isPrivate).toBe(false);
    sb.channels[0].emit("SUBSCRIBED");
    expect(h.onOpen).toHaveBeenCalledTimes(1);
    expect(h.onState).toHaveBeenCalledWith("open");
  });

  it("joins private when enabled and stays private on success", async () => {
    const sb = new FakeSupabase();
    const h = handlers();
    const sig = new SupabaseSignaling(sb as never, "Nori-L2-1", undefined, { private: true });
    await sig.connect(h);
    expect(sb.channels[0].isPrivate).toBe(true);
    sb.channels[0].emit("SUBSCRIBED");
    await tick();
    expect(h.onOpen).toHaveBeenCalledTimes(1);
    expect(sb.channels).toHaveLength(1); // no fallback
  });

  it("a private join error is TERMINAL — never downgrades to public (audit C1)", async () => {
    const sb = new FakeSupabase();
    const h = handlers();
    const sig = new SupabaseSignaling(sb as never, "Nori-L2-1", undefined, { private: true });
    await sig.connect(h);
    // private join fails (e.g. RLS denies a non-paired caller)
    sb.channels[0].emit("CHANNEL_ERROR", new Error("rls denied"));
    await tick();
    // NO second channel — the room is never re-joined as public.
    expect(sb.channels).toHaveLength(1);
    expect(sb.channels[0].isPrivate).toBe(true);
    // The failure surfaces immediately as an error, not a silent public rejoin.
    expect(h.onState).toHaveBeenCalledWith("error");
  });

  it("stays private across reconnects — a re-connect() never goes public either", async () => {
    const sb = new FakeSupabase();
    const h = handlers();
    const sig = new SupabaseSignaling(sb as never, "Nori-L2-1", undefined, { private: true });
    await sig.connect(h);
    sb.channels[0].emit("CHANNEL_ERROR");    // terminal, no downgrade
    await tick();
    await sig.connect(h);                    // reconnect -> still private
    expect(sb.channels[1].isPrivate).toBe(true);
  });
});
