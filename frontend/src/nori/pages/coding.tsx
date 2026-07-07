// NORI: "Run Nori with code" — the Tier-1 script console (docs/llm_integration_plan.md).
//
// The editor drives the SAME persistent teleop session the Remote page connects (via
// TeleopSessionProvider), so the connection survives navigating here from Remote. Run executes
// the code in a sandboxed Web Worker → ScriptDriver → the live RemoteTeleop (identical wire to
// keyboard/VR teleop). The code text and the session both persist across page changes.
//
// Safety: this can move the robot, so execution stays behind the nori_script_console flag. The
// operator is the supervisor — live video is on the Remote page, E-STOP is here and on Remote,
// and the daemon watchdog safe-stops if the tab dies. Motions are open-loop timed (no arrival
// feedback until protocol G1).

import { useContext, useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ThemeProviderContext } from "@/contexts/ThemeContext";
import { Play, Square, OctagonX } from "lucide-react";
import { useTeleopSession } from "@/nori/TeleopSessionContext";
import { ScriptSession } from "@/nori/remote/ScriptSession";
import { isScriptConsoleEnabled } from "@/nori/remote/flags";

const CODE_EXTENSIONS = [javascript({ typescript: true })];

// Shown when the editor is empty, so a first-time user has something runnable.
const STARTER = `// Drive the robot with the injected \`robot\` API. Motions are open-loop timed.
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
  const scriptEnabled = isScriptConsoleEnabled();

  const [prompt, setPrompt] = useState("");
  const [output, setOutput] = useState<string[]>([]);
  const [scriptRunning, setScriptRunning] = useState(false);
  const sessionRef = useRef<ScriptSession | null>(null);
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

  const { theme } = useContext(ThemeProviderContext);
  const editorTheme =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
      : theme;

  const append = (line: string) => setOutput((prev) => [...prev.slice(-300), line]);

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
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold">Run Nori with code</h1>
        {/* Connection status — the session is shared with the Remote page and persists. */}
        <span
          className={
            "rounded-full px-3 py-1 font-mono text-xs " +
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

      {!scriptEnabled && (
        <p className="rounded-md border border-[#b06a1c]/30 bg-[#b06a1c]/10 px-3 py-2 text-sm text-[#8a5416]">
          Script execution is off. Enable it in the browser console, then reload:{" "}
          <code className="font-mono">localStorage.setItem("nori_script_console","1")</code>
        </p>
      )}

      <div className="grid h-[calc(100vh-15rem)] grid-cols-1 gap-4 lg:grid-cols-2">
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
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">LLM codegen writes into the editor → you review → Run</span>
              <Button size="sm" disabled title="LLM codegen — coming (plan D3)"
                className="rounded-md bg-[#d98b3d] text-foreground hover:bg-[#c97929]">
                Generate
              </Button>
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
              value={code}
              onChange={setScriptSource}
              extensions={CODE_EXTENSIONS}
              theme={editorTheme}
              placeholder="// Write code here"
              height="100%"
              style={{ height: "100%" }}
              editable={!scriptRunning}
              className="h-full text-sm [&_.cm-editor]:h-full"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">open-loop timed · half-speed cap · supervisor required</span>
            <div className="flex items-center gap-2">
              {!scriptRunning ? (
                <Button size="sm" onClick={run} disabled={!scriptEnabled || !connected}
                  className="rounded-md bg-[#8ab135] text-foreground hover:bg-[#4d8754]">
                  <Play className="mr-2 h-4 w-4" /> Run
                </Button>
              ) : (
                <Button size="sm" variant="secondary" onClick={stop}>
                  <Square className="mr-2 h-4 w-4" /> Stop
                </Button>
              )}
              <Button size="sm" variant="destructive" className="font-bold" onClick={estop}
                title="Latch the daemon + kill the script + zero motion, immediately">
                <OctagonX className="mr-2 h-4 w-4" /> E-STOP
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Coding;
