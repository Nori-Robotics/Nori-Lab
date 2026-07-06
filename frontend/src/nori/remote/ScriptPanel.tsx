// NORI: Additive file. Tier-1 script console UI (docs/llm_integration_plan.md, Phase C).
//
// Paste a script, Run it, watch output, Stop / E-STOP. The panel owns a ScriptSession (which
// owns the sandbox Worker + the ScriptDriver); it never touches the RTCDataChannel directly.
// Rendered only when the flag is on AND a session is connected (the parent guards that). It
// reports its active state up via onActiveChange so the page can enforce one-writer arbitration
// (disable VR / leader / keyboard-jog while a script drives).
//
// Honesty: the sandbox executes the source as a plain-JS async function body (the `robot` API is
// runtime-typed, so type annotations add nothing at execution and there is no transpile step yet).
// Motions are OPEN-LOOP TIMED — no arrival feedback until protocol G1. Half-speed cap is on. The
// operator is the supervisor: live video + this E-STOP under their hand + the daemon watchdog.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteTeleop, TelemetryView } from "@nori/sdk";
import { Button } from "@/components/ui/button";
import { ScriptSession } from "./ScriptSession";

interface ScriptPanelProps {
  teleop: RemoteTeleop; // non-null: parent only renders this when connected
  telemetry: TelemetryView; // latest frame, forwarded to robot.telemetry()
  onLog: (line: string) => void; // mirror into the page's robot-log
  onActiveChange: (active: boolean) => void; // arbitration: true while a script drives
}

// Phase D1 examples (double as smoke tests). Plain JS against the injected `robot` API.
const EXAMPLES: { name: string; source: string }[] = [
  {
    name: "wave (right arm)",
    source: `// A small wave with the right arm. Open-loop timed.
for (let i = 0; i < 3; i++) {
  await robot.joint("right", { wrist_flex: 0.4 }, 500);
  await robot.joint("right", { wrist_flex: -0.4 }, 500);
}
robot.log("waved");`,
  },
  {
    name: "gripper open/close",
    source: `await robot.grip("right", "open");
await robot.wait(400);
await robot.grip("right", "close");
robot.log("done gripping");`,
  },
  {
    name: "base nudge forward",
    source: `// Gentle forward nudge, then stop. Watch the floor is clear.
await robot.base({ linear: 0.4 }, 800);
robot.log("nudged forward");`,
  },
  {
    name: "read telemetry",
    source: `const t = await robot.telemetry();
robot.log("loopHz=" + (t ? t.loopHz : "n/a") + " safety=" + (t ? t.safety : "n/a"));`,
  },
];

export function ScriptPanel({ teleop, telemetry, onLog, onActiveChange }: ScriptPanelProps) {
  const [source, setSource] = useState(EXAMPLES[0].source);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string[]>([]);
  const sessionRef = useRef<ScriptSession | null>(null);
  const outRef = useRef<HTMLPreElement>(null);

  const append = useCallback((line: string) => {
    setOutput((prev) => [...prev.slice(-300), line]);
  }, []);

  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [output]);

  // Forward every telemetry frame to the live session so robot.telemetry() is current.
  useEffect(() => {
    sessionRef.current?.setTelemetry(telemetry);
  }, [telemetry]);

  const finishState = useCallback(() => {
    setRunning(false);
    onActiveChange(false);
    sessionRef.current = null;
  }, [onActiveChange]);

  const run = useCallback(() => {
    if (sessionRef.current) return;
    setOutput([]);
    const session = new ScriptSession({
      teleop,
      onLog: (line) => {
        append(line);
        onLog(line);
      },
      onError: (message) => append("⚠ " + message),
      onDone: () => finishState(),
    });
    sessionRef.current = session;
    session.setTelemetry(telemetry);
    setRunning(true);
    onActiveChange(true);
    append("▶ running…");
    session.run(source);
  }, [teleop, telemetry, source, append, onLog, onActiveChange, finishState]);

  const stop = useCallback(() => {
    sessionRef.current?.stop();
    finishState();
  }, [finishState]);

  // The real safety path: latch the daemon + kill the worker + zero jog, all at once.
  const estop = useCallback(() => {
    append("■ E-STOP");
    sessionRef.current?.estop();
    if (!sessionRef.current) teleop.command("estop"); // latch even if nothing is running
    finishState();
  }, [teleop, append, finishState]);

  // Kill any running script if the panel unmounts (disconnect / navigate away).
  useEffect(() => () => sessionRef.current?.stop(), []);

  return (
    <div className="space-y-2 rounded-md border border-[#14131a]/10 bg-[#f3f1e8] p-4 text-[#14131a] shadow-sm">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#b06a1c]">
          // script console (experimental)
        </p>
        <label className="flex items-center gap-2 text-sm">
          example
          <select
            className="rounded-md border bg-background px-2 py-1 text-sm"
            disabled={running}
            onChange={(e) => {
              const ex = EXAMPLES[Number(e.target.value)];
              if (ex) setSource(ex.source);
            }}
            defaultValue="0"
          >
            {EXAMPLES.map((ex, i) => (
              <option key={ex.name} value={i}>
                {ex.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <textarea
        className="h-40 w-full rounded border border-[#14131a]/20 bg-background p-2 font-mono text-xs"
        value={source}
        spellCheck={false}
        disabled={running}
        onChange={(e) => setSource(e.target.value)}
      />

      <div className="flex flex-wrap items-center gap-2">
        {!running ? (
          <Button size="sm" onClick={run}>
            Run
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={stop}>
            Stop
          </Button>
        )}
        <Button
          size="sm"
          variant="destructive"
          className="font-bold"
          onClick={estop}
          title="Latch the daemon + kill the script + zero motion, immediately"
        >
          ■ E-STOP
        </Button>
        <span className="text-[11px] text-muted-foreground">
          open-loop timed · half-speed cap · you are the supervisor
        </span>
      </div>

      <pre
        ref={outRef}
        className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-[#14131a]/10 bg-background p-2 font-mono text-[11px]"
      >
        {output.length > 0 ? output.join("\n") : <span className="text-muted-foreground">output…</span>}
      </pre>
    </div>
  );
}
