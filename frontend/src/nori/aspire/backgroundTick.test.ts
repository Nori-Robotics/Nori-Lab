import { afterEach, describe, expect, it, vi } from "vitest";
import { backgroundTick } from "./backgroundTick";

describe("backgroundTick", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("ticks from a worker and stops when asked", () => {
    const made: { onmessage: (() => void) | null; terminate: () => void }[] = [];
    class FakeWorker { onmessage: (() => void) | null = null; terminate = vi.fn(); constructor() { made.push(this); } }
    vi.stubGlobal("Worker", FakeWorker);
    const tick = vi.fn();
    const stop = backgroundTick(2000, tick);
    made[0].onmessage?.();
    expect(tick).toHaveBeenCalledTimes(1);
    stop();
    expect(made[0].terminate).toHaveBeenCalled();
  });

  it("falls back to a timer where a worker cannot start", () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", class { constructor() { throw new Error("blocked"); } });
    const tick = vi.fn();
    const stop = backgroundTick(2000, tick);
    vi.advanceTimersByTime(4000);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(4000);
    expect(tick).toHaveBeenCalledTimes(2);
  });
});
