import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteTeleop } from "@nori/sdk";
import { RecordRequests } from "../../../packages/nori-sdk/src/recordRequests";

afterEach(() => vi.useRealTimers());

describe("recording acknowledgements", () => {
  it("retries the same request ID and ignores a late reply to a different verb", async () => {
    vi.useFakeTimers();
    const sent: Record<string, unknown>[] = [];
    const rpc = new RecordRequests<{ ok: boolean }>((frame) => { sent.push(frame); return true; });
    const first = rpc.request("episode_keep", { episode_id: "one" }, 100);
    const timedOut = expect(first).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100);
    await timedOut;
    const second = rpc.request("episode_reject", { episode_id: "two" });
    rpc.accept(String(sent[0].request_id), { ok: true });
    expect(rpc.owns(String(sent[1].request_id))).toBe(true);
    await vi.advanceTimersByTimeAsync(750);
    expect(sent[2]).toEqual(sent[1]);
    rpc.accept(String(sent[1].request_id), { ok: true });
    await expect(second).resolves.toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports refusal, failed sends, and disconnects instead of claiming success", async () => {
    const rpc = new RecordRequests<{ ok: boolean; error?: string }>(() => true);
    const pending = rpc.request("episode_reject");
    rpc.close();
    await expect(pending).rejects.toThrow(/session closed/);
    await expect(new RecordRequests(() => false).request("episode_reject"))
      .rejects.toThrow(/unavailable/);
  });

  it("SDK sends stable episode identity and only resolves its matching reply", async () => {
    const t = new RemoteTeleop({ arm: "right", onLog: () => {} } as never);
    const sent: Record<string, unknown>[] = [];
    const raw = t as unknown as {
      dcSend: (frame: Record<string, unknown>) => boolean;
      ingestRecordStatus: (frame: Record<string, unknown>) => void;
    };
    raw.dcSend = (frame) => { sent.push(frame); return true; };
    const pending = t.recordConfirmed("episode_reject", { episodeId: "episode-one" });
    expect(sent[0]).toMatchObject({ action: "episode_reject", episode_id: "episode-one" });
    raw.ingestRecordStatus({ type: "record_status", ok: true, request_id: "old", recording: true });
    expect(t.recordState()).toBeNull();
    raw.ingestRecordStatus({ type: "record_status", request_id: sent[0].request_id,
      ok: false, recording: false, error: "delete failed" });
    await expect(pending).rejects.toThrow("delete failed");
  });
});
