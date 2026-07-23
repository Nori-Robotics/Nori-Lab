// Tests for lib/localAuth — ?token= pickup, URL scrub, persistence, and the
// header/WS helpers. Vitest runs in a node environment (see vitest.config.ts),
// so window/localStorage/history are minimal hand-rolled stubs.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getLocalToken,
  initLocalAuth,
  lelabFetch,
  LOCAL_TOKEN_HEADER,
  resetLocalAuthForTests,
  tokenizeWsUrl,
} from "./localAuth";

type Stub = {
  href: string;
  store: Map<string, string>;
  replaced: string[];
};

function stubWindow(href: string): Stub {
  const stub: Stub = { href, store: new Map(), replaced: [] };
  (globalThis as Record<string, unknown>).window = {
    location: {
      get href() {
        return stub.href;
      },
    },
    localStorage: {
      getItem: (k: string) => stub.store.get(k) ?? null,
      setItem: (k: string, v: string) => void stub.store.set(k, v),
    },
    history: {
      state: null,
      replaceState: (_s: unknown, _t: string, url: string) => {
        stub.replaced.push(url);
        stub.href = url;
      },
    },
  };
  return stub;
}

describe("localAuth", () => {
  beforeEach(() => resetLocalAuthForTests());
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
    resetLocalAuthForTests();
  });

  it("picks up ?token=, persists it, and scrubs only that param", () => {
    const stub = stubWindow("http://localhost:8080/?api=http%3A%2F%2Fx:8000&token=sekret&room=r1");
    initLocalAuth();
    expect(getLocalToken()).toBe("sekret");
    expect(stub.store.get("lelab.apiToken")).toBe("sekret");
    expect(stub.replaced).toHaveLength(1);
    const scrubbed = new URL(stub.replaced[0]);
    expect(scrubbed.searchParams.get("token")).toBeNull();
    expect(scrubbed.searchParams.get("api")).toBe("http://x:8000");
    expect(scrubbed.searchParams.get("room")).toBe("r1");
  });

  it("falls back to the persisted token when the URL has none", () => {
    const stub = stubWindow("http://localhost:8080/");
    stub.store.set("lelab.apiToken", "earlier");
    initLocalAuth();
    expect(getLocalToken()).toBe("earlier");
    expect(stub.replaced).toHaveLength(0); // no rewrite when nothing to scrub
  });

  it("returns null (and does not throw) with no window at all", () => {
    expect(getLocalToken()).toBeNull();
  });

  it("tokenizeWsUrl appends with ? or & as appropriate, and passes through untokened", () => {
    stubWindow("http://localhost:8080/?token=t%26x"); // token needing encoding
    initLocalAuth();
    expect(tokenizeWsUrl("ws://localhost:8000/ws/joint-data")).toBe(
      "ws://localhost:8000/ws/joint-data?token=t%26x"
    );
    expect(tokenizeWsUrl("ws://h/ws?a=1")).toBe("ws://h/ws?a=1&token=t%26x");

    resetLocalAuthForTests();
    stubWindow("http://localhost:8080/");
    initLocalAuth();
    expect(tokenizeWsUrl("ws://h/ws")).toBe("ws://h/ws");
  });

  it("lelabFetch attaches the header only when a token is known", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
    (globalThis as Record<string, unknown>).fetch = (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers as Record<string, string> | undefined });
      return Promise.resolve({ ok: true } as Response);
    };

    stubWindow("http://localhost:8080/?token=abc");
    initLocalAuth();
    await lelabFetch("http://localhost:8000/nori/capture/ping");
    expect(seen[0].headers?.[LOCAL_TOKEN_HEADER]).toBe("abc");

    // Existing init fields survive the merge.
    await lelabFetch("http://localhost:8000/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(seen[1].headers?.["Content-Type"]).toBe("application/json");
    expect(seen[1].headers?.[LOCAL_TOKEN_HEADER]).toBe("abc");

    resetLocalAuthForTests();
    stubWindow("http://localhost:8080/");
    initLocalAuth();
    await lelabFetch("http://localhost:8000/y");
    expect(seen[2].headers?.[LOCAL_TOKEN_HEADER]).toBeUndefined();

    delete (globalThis as Record<string, unknown>).fetch;
  });
});
