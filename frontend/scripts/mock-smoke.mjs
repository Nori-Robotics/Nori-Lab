#!/usr/bin/env node
// NORI: Additive (SDK v1 mock mode). Headless driver for the @nori/sdk/mock browser smoke.
//
// Runs /mock-smoke.html in real headless Chrome and reports pass/fail. Exists because the mock's
// WebRTC shell (RTCPeerConnection, the robot-opened data channel, canvas captureStream) cannot
// execute in Node at all — the vitest suite covers the pure sim, this covers everything else.
//
//   npm run smoke:mock            # from frontend/
//   CHROME=/path/to/chrome npm run smoke:mock
//
// DEPENDENCY-FREE BY DESIGN: speaks CDP over Node's built-in WebSocket (Node >= 22) and spawns
// the system Chrome, rather than pulling playwright/puppeteer into the app's dep tree for one
// dev-only check. If this ever needs a second page or real input events, revisit that call.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VITE_PORT = process.env.SMOKE_PORT ?? "5199";
const CDP_PORT = process.env.SMOKE_CDP_PORT ?? "9333";
const URL_UNDER_TEST = `http://127.0.0.1:${VITE_PORT}/mock-smoke.html`;
const CHROME =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OVERALL_TIMEOUT_MS = 120_000;

const procs = [];
let userDataDir;

const log = (...m) => console.log("[smoke]", ...m);

async function waitForHttp(url, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json().catch(() => ({}));
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label} (${url})`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// Minimal CDP client: send a command, await its matching id.
function cdp(ws) {
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method === "Runtime.consoleAPICalled") {
      const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
      if (text) console.log("  ·", text);
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      console.log("  ! page exception:", d.exception?.description ?? d.text);
    }
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
}

async function main() {
  // 1. Vite dev server (serves the page + resolves the @nori/sdk aliases straight from src/).
  log(`starting vite on :${VITE_PORT}…`);
  const vite = spawn("npx", ["vite", "--port", VITE_PORT, "--strictPort"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(vite);
  vite.stderr.on("data", (d) => process.env.SMOKE_VERBOSE && console.log("  vite!", String(d).trim()));
  await waitForHttp(URL_UNDER_TEST, 30_000, "vite dev server");
  log("vite up");

  // 2. Headless Chrome with a throwaway profile.
  userDataDir = await mkdtemp(join(tmpdir(), "nori-smoke-"));
  log("launching headless chrome…");
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--autoplay-policy=no-user-gesture-required",
      URL_UNDER_TEST,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  procs.push(chrome);
  chrome.stderr.on("data", (d) => process.env.SMOKE_VERBOSE && console.log("  chrome!", String(d).trim()));

  // 3. Attach to the page target.
  await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 20_000, "chrome devtools");
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
    page = targets.find((t) => t.type === "page" && t.url.includes("mock-smoke"));
    if (!page) await new Promise((r) => setTimeout(r, 200));
  }
  if (!page) throw new Error("no mock-smoke page target in chrome");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("CDP websocket failed")), { once: true });
  });
  const send = cdp(ws);
  await send("Runtime.enable");
  log("attached; running smoke in-page…");

  // 4. Poll for the report the page publishes on window.__SMOKE__.
  const t0 = Date.now();
  let report = null;
  for (;;) {
    const { result } = await send("Runtime.evaluate", {
      expression: "JSON.stringify(window.__SMOKE__ ?? null)",
      returnByValue: true,
    });
    const parsed = result.value ? JSON.parse(result.value) : null;
    if (parsed?.done) {
      report = parsed;
      break;
    }
    if (Date.now() - t0 > OVERALL_TIMEOUT_MS) {
      report = parsed;
      console.log("\n[smoke] TIMED OUT — partial report below");
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log("");
  if (!report) throw new Error("page never published a report (window.__SMOKE__ absent)");
  for (const r of report.results) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? `\n      ${r.detail}` : ""}`);
  }
  console.log("");
  const failed = report.fail > 0 || !report.done;
  log(`${report.pass} passed, ${report.fail} failed${report.done ? "" : " (incomplete)"}`);
  return failed ? 1 : 0;
}

async function cleanup() {
  for (const p of procs) {
    try {
      p.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error("[smoke] ERROR:", e.message);
  code = 1;
} finally {
  await cleanup();
}
process.exit(code);
