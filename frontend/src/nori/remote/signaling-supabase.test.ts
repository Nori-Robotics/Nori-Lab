// Tests for the SDK Supabase signaling transport's private-room opt-in (Signaling
// Phase 1, 1e): private-first join with a one-time public fallback, gated off by default.
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

  it("falls back to public ONCE on a private join error", async () => {
    const sb = new FakeSupabase();
    const h = handlers();
    const sig = new SupabaseSignaling(sb as never, "Nori-L2-1", undefined, { private: true });
    await sig.connect(h);
    // private join fails -> retry as public
    sb.channels[0].emit("CHANNEL_ERROR", new Error("rls denied"));
    await tick();
    expect(sb.channels).toHaveLength(2);
    expect(sb.channels[1].isPrivate).toBe(false);
    expect(sb.channels[0].unsubscribed).toBe(true);
    // onState('error') must NOT have fired yet — the fallback is in flight
    expect(h.onState).not.toHaveBeenCalledWith("error");
    // a second failure (now public) surfaces as error, no third attempt
    sb.channels[1].emit("CHANNEL_ERROR");
    await tick();
    expect(sb.channels).toHaveLength(2);
    expect(h.onState).toHaveBeenCalledWith("error");
  });

  it("retries private again on a fresh connect() (robot may be provisioned since)", async () => {
    const sb = new FakeSupabase();
    const h = handlers();
    const sig = new SupabaseSignaling(sb as never, "Nori-L2-1", undefined, { private: true });
    await sig.connect(h);
    sb.channels[0].emit("CHANNEL_ERROR");   // fall back to public
    await tick();
    expect(sb.channels[1].isPrivate).toBe(false);
    await sig.connect(h);                    // reconnect -> private-first again
    expect(sb.channels[2].isPrivate).toBe(true);
  });
});
