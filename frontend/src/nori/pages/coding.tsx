// NORI: "Run Nori with code" — the Tier-1 script console (docs/llm_integration_plan.md).
//
// The editor drives the SAME persistent teleop session the Remote page connects (via
// TeleopSessionProvider), so the connection survives navigating here from Remote. Run executes
// the code in a sandboxed Web Worker → ScriptDriver → the live RemoteTeleop (identical wire to
// keyboard/VR teleop). The code text and the session both persist across page changes.
//
// Safety: this can move the robot. The operator is the supervisor — live video is on the Remote
// page, E-STOP is here and on Remote, and the daemon watchdog safe-stops if the tab dies. Timed
// jogs (reach/joint/grip) are open-loop; moveTo waits for the daemon's arrival result (done/blocked/
// clamped/timeout). The robot's own clamps/watchdog are the real boundary (the daemon defends
// itself), which is why this ships without a client-side gate.

import { useContext, useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { EditorView } from "@codemirror/view";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ThemeProviderContext } from "@/contexts/ThemeContext";
import { Play, Square, OctagonX } from "lucide-react";
import { useTeleopSession } from "@/nori/TeleopSessionContext";
import { ScriptSession } from "@/nori/remote/ScriptSession";
import { startMockPerception, type MockPerceptionHandle } from "@/nori/remote/mockPerception";
import { useApi } from "@/contexts/ApiContext";

const CODE_EXTENSIONS = [javascript({ typescript: true }), EditorView.lineWrapping];

// Lenient client-side fence strip for the STREAMED output (the model is told not to fence, but
// unwrap gracefully if it does — incrementally: drop a leading ```lang line, and a trailing ```).
function stripFences(s: string): string {
  let out = s;
  if (out.startsWith("```")) {
    const nl = out.indexOf("\n");
    out = nl >= 0 ? out.slice(nl + 1) : "";
  }
  const close = out.lastIndexOf("```");
  if (close >= 0 && out.slice(close).trim() === "```") out = out.slice(0, close);
  return out;
}

// Does `src` parse as the body of an async function (how the worker runs it)? Compiling via the
// AsyncFunction constructor throws SyntaxError on bad code WITHOUT executing it — a pure parse check.
const AsyncFunctionCtor = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => unknown;
function isValidScript(src: string): boolean {
  try { new AsyncFunctionCtor("robot", src); return true; } catch { return false; }
}

// Blob -> bare base64 (no "data:image/jpeg;base64," prefix) for the LLM image block.
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(",", 2)[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Shown when the editor is empty, so a first-time user has something runnable.
const STARTER = `// Drive the robot with the injected \`robot\` API. Timed jogs; moveTo waits for arrival.
// The robot moves only while a script runs; you are the supervisor (E-STOP below).

await robot.joint("left", { elbow_flex: 0.3 }, 800);   // per-joint jog, held 800ms
await robot.wait(300);
await robot.grip("left", "open");
robot.log("done");
`;

const Coding = () => {
  const {
    teleop, connState, connecting, connect, tel, scriptSource, setScriptSource,
  } = useTeleopSession();
  const { baseUrl, fetchWithHeaders } = useApi();

  const [prompt, setPrompt] = useState("");
  const [output, setOutput] = useState<string[]>([]);
  const [scriptRunning, setScriptRunning] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [streamBuffer, setStreamBuffer] = useState(""); // live LLM tokens while generating
  const [attachVision, setAttachVision] = useState(false); // Part 3: send a camera still to the model
  const [cameraLayout, setCameraLayout] = useState(() => {
    try { return localStorage.getItem("nori_camera_layout") ?? ""; } catch { return ""; }
  });
  const [lastFrame, setLastFrame] = useState<string | null>(null); // data URL of the last attached frame
  const [mockPerception, setMockPerception] = useState(false); // dev: feed synthetic robot.perceive() frames
  const sessionRef = useRef<ScriptSession | null>(null);
  const mockPerceptionRef = useRef<MockPerceptionHandle | null>(null);
  const outRef = useRef<HTMLDivElement>(null);

  const code = scriptSource;
  const connected = connState === "connected";
  const status = connected
    ? `connected · ${Math.round(tel.loopHz)} Hz`
    : connecting ? "connecting…" : "not connected";

  // Seed the editor once if it's empty (persisted afterwards).
  useEffect(() => {
    if (!scriptSource) setScriptSource(STARTER);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [output]);

  // Keep robot.telemetry() current inside a running script.
  useEffect(() => { sessionRef.current?.setTelemetry(tel); }, [tel]);

  // Stop a running script if we navigate away (the SESSION persists; only the script stops).
  useEffect(() => () => sessionRef.current?.stop(), []);

  // Dev: start/stop the synthetic perception feed so robot.perceive() returns data before the on-Pi
  // detector exists (Phase F). Off by default; injects through the same path a real frame takes.
  useEffect(() => {
    if (mockPerception && teleop) {
      mockPerceptionRef.current = startMockPerception(teleop);
      append("🫧 mock perception ON (dev) — robot.perceive() now returns synthetic objects");
    }
    return () => { mockPerceptionRef.current?.stop(); mockPerceptionRef.current = null; };
  }, [mockPerception, teleop]);

  const { theme } = useContext(ThemeProviderContext);
  const editorTheme =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
      : theme;

  const append = (line: string) => setOutput((prev) => [...prev.slice(-300), line]);

  // LLM codegen: ask the server-side Claude proxy (/nori/llm/generate) for a routine and drop it
  // into the editor. The generated code is fully editable — the operator reviews, then Runs. The
  // API key stays on the server (see docs/llm_codegen_design.md); the browser never sees it.
  // One streamed request → the finished (fence-stripped) code, live-updating the editor buffer.
  const runGeneration = async (
    robotState: Record<string, number>, imageB64: string | undefined, retryNote?: string,
  ): Promise<string> => {
    const res = await fetchWithHeaders(`${baseUrl}/nori/llm/generate/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt, current_code: code, robot_state: robotState, image_b64: imageB64,
        // Operator text overrides; else the bridge-derived layout (which tile is which camera); else
        // nothing (the model is told not to assume). So vision knows which feed is which arm by default.
        camera_layout: imageB64 ? (cameraLayout.trim() || teleop?.cameraLayout() || undefined) : undefined,
        retry_note: retryNote,
      }),
    });
    if (!res.ok || !res.body) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail?.detail || res.statusText);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let acc = "";
    setStreamBuffer("");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
      setStreamBuffer(stripFences(acc));
    }
    return stripFences(acc);
  };

  const generate = async () => {
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    try {
      // 9a — proprioceptive grounding: hand the model the CURRENT pose so it can plan relative to
      // where the arm actually is ("pan is at +20 → jog negative to center") instead of guessing.
      const robotState = Object.fromEntries(
        Object.entries(tel.state ?? {}).map(([k, v]) => [k, Math.round(v * 10) / 10]),
      );
      // Part 3: optionally attach a camera still (snapshot() resumes the encoder if paused, grabs one
      // frame, re-pauses) + show the operator a thumbnail of what the model actually saw.
      let imageB64: string | undefined;
      if (attachVision && teleop) {
        const blob = await teleop.snapshot();
        if (blob) {
          imageB64 = await blobToBase64(blob);
          setLastFrame("data:image/jpeg;base64," + imageB64);
          append("📷 attached a camera frame");
        } else {
          setLastFrame(null);
          append("⚠ no camera frame (video not arriving) — sending without vision");
        }
      }
      // #3 — validate the result parses as JS; auto-retry ONCE with a firmer hint if the model
      // slipped in uncommented prose. (Parse-check is client-side — the browser is the JS engine.)
      let generated = await runGeneration(robotState, imageB64);
      if (!isValidScript(generated)) {
        append("⚠ generated code had a syntax error — regenerating once…");
        generated = await runGeneration(robotState, imageB64,
          "Your previous output had a JavaScript syntax error (often uncommented prose). Output ONLY valid JS; put any explanation in // comments.");
      }
      setScriptSource(generated);
      append(isValidScript(generated)
        ? `✎ generated ${generated.split("\n").length} lines — review, then Run`
        : `⚠ generated ${generated.split("\n").length} lines but it still won't parse — review before Run`);
    } catch (e) {
      append("⚠ generate failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setGenerating(false);
    }
  };

  const run = () => {
    if (sessionRef.current) return;
    if (!teleop || !connected) { append("⚠ not connected — press Connect (or connect on Remote) first"); return; }
    setOutput([]);
    const session = new ScriptSession({
      teleop,
      onLog: (line) => append(line),
      onError: (message) => append("⚠ " + message),
      onDone: () => { setScriptRunning(false); sessionRef.current = null; },
    });
    sessionRef.current = session;
    session.setTelemetry(tel);
    setScriptRunning(true);
    append("▶ running…");
    session.run(code);
  };

  const stop = () => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setScriptRunning(false);
  };

  // Real safety path: latch the daemon + kill the worker + zero motion, at once.
  const estop = () => {
    append("■ E-STOP");
    sessionRef.current?.estop();
    if (!sessionRef.current) teleop?.command("estop");
    sessionRef.current = null;
    setScriptRunning(false);
  };

  return (
    // Marketplace-hero wash over the whole page: dot grid + blurred leaf/custard blobs
    // behind the cards. The 50vw-50% negative margins bleed the wash past the centered
    // content column to the viewport edges (padding restores the column); the content
    // wrapper is positioned so it paints above the absolute layers.
    <section className="relative -my-6 -mx-[calc(50vw-50%)] min-h-[calc(100vh-3.5rem)] overflow-hidden px-[calc(50vw-50%)] py-6">
      <div className="dot-grid pointer-events-none absolute inset-0 opacity-60" aria-hidden />
      <div
        className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-leaf opacity-70 blur-3xl"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -right-20 top-32 h-64 w-64 rounded-full bg-sticker opacity-60 blur-3xl"
        aria-hidden
      />
      <div className="relative space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">Run Nori with code</h1>
        {/* Connection status — the session is shared with the Remote page and persists. Grouped
            on the far right for consistency with the Agent page header. */}
        <div className="flex items-center gap-3">
          <span
            className={
              "inline-flex h-9 items-center rounded-full px-3 font-mono text-xs " +
              (connected ? "bg-[#8ab135]/25 text-[#4d6a1e]" : "bg-[#14131a]/8 text-[#857b6b]")
            }
          >
            ● {status}
          </span>
          {!connected && (
            <Button size="sm" variant="secondary" onClick={connect} disabled={connecting}>
              {connecting ? "Connecting…" : "Connect"}
            </Button>
          )}
        </div>
      </div>

      <div className="grid h-[calc(100vh-12rem)] grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Left: LLM prompt (codegen — D3, not wired yet) + run output log */}
        <div className="flex h-full min-h-0 flex-col gap-4">
          <div className="flex flex-1 min-h-0 flex-col gap-2 rounded-md border border-[#14131a]/10 bg-[#f6f4eb] p-4 text-[#14131a] shadow-sm">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#b06a1c]">// prompt</span>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe what the robot should do…"
              className="flex-1 resize-none border-[#14131a]/12 bg-[#fffdf7]"
            />
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                    title="Attach a still from the robot camera so Claude can see the scene">
                    <input type="checkbox" checked={attachVision}
                      onChange={(e) => setAttachVision(e.target.checked)} />
                    attach camera view
                  </label>
                  <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                    title="Dev: feed synthetic robot.perceive() frames so reactive scripts run before the on-Pi detector exists (Phase F)">
                    <input type="checkbox" checked={mockPerception}
                      onChange={(e) => setMockPerception(e.target.checked)} />
                    mock perception (dev)
                  </label>
                </div>
                <Button size="sm" onClick={generate} disabled={generating || !prompt.trim()}
                  title="Generate a routine with Claude and drop it into the editor"
                  className="rounded-md bg-[#d98b3d] text-foreground hover:bg-[#c97929]">
                  {generating ? "Generating…" : "Generate"}
                </Button>
              </div>
              {attachVision && (
                <div className="flex flex-col gap-1">
                  <div className="flex items-start gap-2">
                    <input
                      type="text"
                      value={cameraLayout}
                      onChange={(e) => {
                        setCameraLayout(e.target.value);
                        try { localStorage.setItem("nori_camera_layout", e.target.value); } catch { /* ignore */ }
                      }}
                      placeholder={
                        teleop?.cameraLayout()
                          ? "camera layout — auto-detected from the robot; type only to override"
                          : "camera layout — e.g. 'left tile = front cam; right tile = right-arm wrist cam'"
                      }
                      title="Which camera tile is which view/arm. Auto-detected from the robot in composite mode; type to override."
                      className="flex-1 rounded border border-[#14131a]/20 bg-[#fffdf7] px-2 py-1 text-[11px]"
                    />
                    {lastFrame && (
                      <img src={lastFrame} alt="last frame sent to Claude" title="what Claude saw"
                        className="h-12 w-auto rounded border border-[#14131a]/20" />
                    )}
                  </div>
                  {teleop?.cameraLayout() && !cameraLayout.trim() && (
                    <span className="text-[10px] text-muted-foreground" title="Sent to Claude with the frame">
                      auto: {teleop.cameraLayoutInfo()?.tiles.join(", ")}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-1 min-h-0 flex-col gap-2 rounded-md border border-[#14131a]/10 bg-[#f6f4eb] p-4 text-[#14131a] shadow-sm">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#b06a1c]">// run output</span>
            <div ref={outRef} className="flex-1 overflow-y-auto whitespace-pre-wrap rounded-md border border-[#14131a]/10 bg-[#f3f1e8] p-3 font-mono text-xs text-[#5a5346]">
              {output.length > 0 ? output.join("\n") : "Run output + robot.log() appear here."}
            </div>
          </div>
        </div>

        {/* Right: code editor + run / stop / e-stop */}
        <div className="flex h-full min-h-0 flex-col gap-2 rounded-md border border-[#14131a]/10 bg-[#f6f4eb] p-4 text-[#14131a] shadow-sm">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#b06a1c]">// code</span>
          <div className="flex-1 min-h-0 overflow-hidden rounded-md border border-[#14131a]/12">
            <CodeMirror
              value={generating ? streamBuffer : code}
              onChange={setScriptSource}
              extensions={CODE_EXTENSIONS}
              theme={editorTheme}
              placeholder="// Write code here"
              height="100%"
              style={{ height: "100%" }}
              editable={!scriptRunning && !generating}
              className="h-full text-[11px] [&_.cm-editor]:h-full"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">moveTo reports arrival · timed jogs · half-speed limit · supervisor required</span>
            <div className="flex items-center gap-2">
              {!scriptRunning ? (
                <Button size="sm" onClick={run} disabled={!connected}
                  className="rounded-md bg-[#8ab135] text-foreground hover:bg-[#799c2a]">
                  <Play className="mr-2 h-4 w-4" /> Run
                </Button>
              ) : (
                <Button size="sm" variant="secondary" onClick={stop}>
                  <Square className="mr-2 h-4 w-4" /> Stop
                </Button>
              )}
              <Button size="sm" variant="destructive" className="font-bold" onClick={estop}
                title="Stop the robot + kill the script + zero motion, immediately">
                <OctagonX className="mr-2 h-4 w-4" /> E-STOP
              </Button>
            </div>
          </div>
        </div>
      </div>
      </div>
    </section>
  );
};

export default Coding;
