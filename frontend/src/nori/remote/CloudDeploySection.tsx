// NORI: Additive file. "Cloud inference (MolmoAct2)" — a section under the
// Deploy-a-policy card for running a REMOTE vision-language-action model instead
// of a locally-cached ACT policy. lelab owns the endpoint URL + bearer token and
// a chunk queue (see lelab/nori_cloud_rollout.py); the browser loop is identical
// to a local rollout — only motor frames reach the robot, subject to every
// daemon-side safety layer. The VLA is single-arm: it drives the chosen arm and
// the daemon holds the other.
//
// Kept as its own component (not folded into PolicyDeployCard) so a parallel
// restyle of that card doesn't collide with this feature.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useApi } from "@/contexts/ApiContext";
import { useTeleopSession } from "@/nori/TeleopSessionContext";
import { PolicyRunner, type PolicyRunPhase } from "@/nori/remote/policyRun";

// A cloud VLA isn't in the local policy cache; this sentinel ref is only used for
// display/logging server-side — the actual endpoint comes from NORI_INFER_URL.
const CLOUD_REF = "cloud:molmoact2";

export function CloudDeploySection() {
  const { baseUrl } = useApi();
  const { teleop, running, tel } = useTeleopSession();
  const { toast } = useToast();

  const [instruction, setInstruction] = useState("");
  const [arm, setArm] = useState<"left" | "right">("left");
  // Default to observe-only: an unproven cloud policy should NOT drive the arm on
  // its first run — watch the predicted targets in the console first, then untick.
  const [observeOnly, setObserveOnly] = useState(true);
  const [phase, setPhase] = useState<PolicyRunPhase>({ kind: "idle" });

  const runnerRef = useRef<PolicyRunner | null>(null);
  const telRef = useRef(tel);
  useEffect(() => {
    telRef.current = tel;
  }, [tel]);

  // Leaving the page must stop the robot — its Stop button goes with it.
  useEffect(() => () => void runnerRef.current?.stop("left the remote page"), []);

  const busy = phase.kind === "loading" || phase.kind === "running";
  const canRun = running && !!teleop && instruction.trim().length > 0 && !busy;

  const run = useCallback(async () => {
    if (!teleop || !instruction.trim()) return;
    if (!runnerRef.current) runnerRef.current = new PolicyRunner(baseUrl, () => telRef.current);
    const runner = runnerRef.current;
    runner.onPhase = setPhase;
    try {
      await runner.start(teleop, CLOUD_REF, undefined, {
        instruction: instruction.trim(),
        arm,
        observeOnly,
      });
    } catch (e) {
      toast({
        title: "Couldn't start cloud policy",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  }, [baseUrl, teleop, instruction, arm, observeOnly, toast]);

  const stop = useCallback(() => void runnerRef.current?.stop(), []);

  return (
    <div className="space-y-2 border-t border-[#14131a]/10 pt-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#b06a1c]">
          {"// cloud VLA (MolmoAct2)"}
        </span>
        {busy && <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />}
      </div>
      <p className="text-xs leading-relaxed text-[#6f6858]">
        Runs a remote vision-language model. Type a task, pick the arm, and it drives that arm from
        the cloud (the other arm is held). Experimental — validate behavior before trusting it.
      </p>

      <input
        type="text"
        value={instruction}
        disabled={busy}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="Task, e.g. “pick up the red cup”"
        className="w-full rounded-md border border-[#14131a]/15 bg-white/70 px-3 py-1.5 text-sm text-[#14131a] placeholder:text-[#b3ac9c] focus:outline-none focus:ring-1 focus:ring-[#b06a1c] disabled:opacity-50"
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#6f6858]">arm</span>
        <div className="flex gap-1.5">
          {(["left", "right"] as const).map((a) => (
            <button
              key={a}
              type="button"
              disabled={busy}
              onClick={() => setArm(a)}
              className={`rounded-full px-3 py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors disabled:opacity-50 ${
                arm === a ? "bg-[#b06a1c] text-white" : "bg-white/70 text-[#6f6858] hover:text-[#14131a]"
              }`}
            >
              {a}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {busy && (
            <span className="text-xs text-[#6f6858]">
              {phase.kind === "loading"
                ? "loading…"
                : `${observeOnly ? "observing" : "driving"} · ${phase.kind === "running" ? phase.ticks : 0} ticks`}
            </span>
          )}
          {busy ? (
            <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              className={`h-7 px-3 text-xs ${observeOnly ? "" : "bg-red-600 hover:bg-red-700"}`}
              disabled={!canRun}
              onClick={() => void run()}
            >
              {observeOnly ? "Observe" : "Drive robot"}
            </Button>
          )}
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs text-[#6f6858]">
        <input
          type="checkbox"
          checked={observeOnly}
          disabled={busy}
          onChange={(e) => setObserveOnly(e.target.checked)}
          className="h-3.5 w-3.5 accent-[#b06a1c]"
        />
        Observe only — log predicted actions, don&apos;t move the robot (recommended for the first run)
      </label>

      {phase.kind === "stopped" && <p className="text-xs text-[#6f6858]">Stopped — {phase.reason}</p>}
      {phase.kind === "error" && <p className="text-xs text-red-700">{phase.message}</p>}
      {!running && <p className="text-xs text-[#6f6858]">Connect to the robot first.</p>}
    </div>
  );
}
