// Tests for the SDK Supabase signaling transport's private-room join (Signaling
// Phase 1). A private join is either explicit-public (opts.private=false) or
// private-and-terminal-on-error: there is NO private->public downgrade (audit C1).
import { describe, it, expect, vi } from "vitest";
import { SupabaseSignaling } from "@nori/sdk/supabase";

type SubCb = (status: string, err?: unknown) => void;

class FakeChannel {
  subCb: SubCb | null = null;
  unsubscribed = false;
  removed = false;
  constructor(public topic: string, public opts: { config?: { private?: boolean } }) {}
  on() { return this; }
  subscribe(cb: SubCb) { this.subCb = cb; return this; }
  async unsubscribe() { this.unsubscribed = true; return "ok"; }
  emit(status: string, err?: unknown) { this.subCb?.(status, err); }
  get isPrivate() { return this.opts.config?.private; }
}

class FakeSupabase {
  channels: FakeChannel[] = [];   // append-only creation log (all channels ever made)
  removed: FakeChannel[] = [];    // channels dropped via removeChannel()
  channel(topic: string, opts: { config?: { private?: boolean } }) {
    const c = new FakeChannel(topic, opts);
    this.channels.push(c);
    return c as unknown as ReturnType<typeof this.channel>;
  }
  // Mirrors supabase-js removeChannel: unsubscribe AND drop from the client registry.
  async removeChannel(ch: unknown) {
    const c = ch as FakeChannel;
    await c.unsubscribe();
    c.removed = true;
    this.removed.push(c);
    return "ok";
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

  // Reconnect fix: close() must removeChannel (unsubscribe + drop from the shared client's
  // registry), not bare unsubscribe. A stale channel left in the registry collides with the
  // next connect on the same room topic, which never SUBSCRIBEs — the bug that forced a hard
  // page reload to reconnect after every disconnect.
  it("close() removes the channel from the client registry, not just unsubscribe", async () => {
    const sb = new FakeSupabase();
    const h = handlers();
    const sig = new SupabaseSignaling(sb as never, "NORI-A3-0000", undefined, { private: true });
    await sig.connect(h);
    sb.channels[0].emit("SUBSCRIBED");
    await sig.close();
    expect(sb.channels[0].removed).toBe(true);
    expect(sb.removed).toContain(sb.channels[0]);
  });

  it("reconnect after close() opens a FRESH channel (no hard reload needed)", async () => {
    const sb = new FakeSupabase();
    const h = handlers();
    const sig = new SupabaseSignaling(sb as never, "NORI-A3-0000", undefined, { private: true });
    await sig.connect(h);
    sb.channels[0].emit("SUBSCRIBED");
    expect(h.onOpen).toHaveBeenCalledTimes(1);

    await sig.close();                       // the disconnect
    await sig.connect(h);                    // reconnect on the SAME room topic

    // A genuinely new channel was created and the old one was removed on close — so the
    // reconnect's subscribe isn't shadowed by a dead sibling.
    expect(sb.channels).toHaveLength(2);
    expect(sb.removed).toContain(sb.channels[0]);
    sb.channels[1].emit("SUBSCRIBED");
    expect(h.onOpen).toHaveBeenCalledTimes(2); // the reconnect actually opens
  });
});
