// NORI: Additive file. "Deploy a policy" — a compact list on the Remote page,
// under the record card, of policies downloaded to the local Nori cache. Click
// Run and the policy executes on THIS computer (the lelab rollout subprocess);
// only motor instructions are streamed to the robot — the exact architecture as
// the marketplace "Run on robot" (see policyRun.ts / lelab/nori_rollout.py).
//
// Desktop-only: the local-policy cache and the rollout subprocess live in lelab,
// so the card renders nothing on the hosted app (the list fetch is LeLab-only).

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useApi } from "@/contexts/ApiContext";
import { useTeleopSession } from "@/nori/TeleopSessionContext";
import { deleteLocalPolicy, listLocalPolicies, listPolicies, type LocalPolicy } from "@/nori/api/client";
import {
  PolicyRunner,
  EXECUTION_PRESETS,
  EXECUTION_MODE_LABELS,
  type ExecutionMode,
  type PolicyRunPhase,
} from "@/nori/remote/policyRun";
import { CloudDeploySection } from "@/nori/remote/CloudDeploySection";
import { isCloudServeEnabled } from "@/nori/remote/flags";

// A policy ref looks like "NoriRobotics/customer-xxxx:job-uuid" or a slug — show
// a readable tail for the compact row.
function shortRef(ref: string): string {
  const tail = ref.split(/[/:]/).pop() || ref;
  return tail.length > 30 ? tail.slice(0, 29) + "…" : tail;
}

// Local bundles whose policy class is language-conditioned: /load requires an
// instruction (nori_rollout.py _LANGUAGE_POLICY_TYPES — keep in sync).
const LANGUAGE_POLICY_CLASSES = new Set(["smolvla"]);

// defaultOpen: start expanded — for layouts that already put the card behind
// their own drawer/tab. unavailableNote: what to render instead of nothing
// when there's no local lelab (an empty drawer body reads as a bug).
export function PolicyDeployCard({
  defaultOpen = false,
  unavailableNote,
}: { defaultOpen?: boolean; unavailableNote?: ReactNode } = {}) {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { teleop, running, tel } = useTeleopSession();
  const { toast } = useToast();

  const [available, setAvailable] = useState(true);
  const [policies, setPolicies] = useState<LocalPolicy[]>([]);
  // ref -> human-readable title (from the policy catalog; local cache has no name)
  const [titleByRef, setTitleByRef] = useState<Record<string, string>>({});
  // ref -> policy class (same catalog fetch) — decides which rows need an instruction
  const [classByRef, setClassByRef] = useState<Record<string, string>>({});
  // ref -> the operator's instruction for a language-conditioned bundle
  const [instrByRef, setInstrByRef] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(defaultOpen);
  const [mode, setMode] = useState<ExecutionMode>("smooth");
  const [runState, setRunState] = useState<{ ref: string | null; phase: PolicyRunPhase }>({
    ref: null,
    phase: { kind: "idle" },
  });
  // Pending local-cache removal (confirmation dialog, like other deletes).
  const [removing, setRemoving] = useState<LocalPolicy | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  const runnerRef = useRef<PolicyRunner | null>(null);
  // Keep the latest telemetry in a ref for the runner's safety monitor.
  const telRef = useRef(tel);
  useEffect(() => {
    telRef.current = tel;
  }, [tel]);

  const refresh = useCallback(() => {
    listLocalPolicies(baseUrl, fetchWithHeaders)
      .then((p) => {
        setPolicies(p);
        setAvailable(true);
      })
      .catch(() => setAvailable(false)); // hosted app / no local lelab spool
    // Best-effort: the catalog carries the human-readable title + policy class
    // for each ref (the local cache stores neither).
    listPolicies(baseUrl, fetchWithHeaders)
      .then((cat) => {
        setTitleByRef(Object.fromEntries(cat.map((c) => [c.ref, c.title])));
        setClassByRef(
          Object.fromEntries(
            cat.flatMap((c) => (c.policy_class ? [[c.ref, c.policy_class]] : [])),
          ),
        );
      })
      .catch(() => {
        setTitleByRef({});
        setClassByRef({});
      });
  }, [baseUrl, fetchWithHeaders]);

  const nameFor = useCallback(
    (ref: string) => titleByRef[ref] || shortRef(ref),
    [titleByRef],
  );

  // Remove an installed policy from this computer's cache. Local-only: the
  // cloud checkpoint is untouched, so it can be re-installed from My Stuff.
  const confirmRemove = useCallback(async () => {
    if (!removing) return;
    setRemoveBusy(true);
    try {
      await deleteLocalPolicy(baseUrl, fetchWithHeaders, removing.ref);
      toast({ title: "Removed from this computer", description: nameFor(removing.ref) });
      setRemoving(null);
      refresh();
    } catch (e) {
      toast({
        title: "Couldn't remove policy",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setRemoveBusy(false);
    }
  }, [removing, baseUrl, fetchWithHeaders, nameFor, refresh, toast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Leaving the page (or unmounting) stops the policy — the robot must never
  // keep moving under a controller whose Stop button is no longer on screen.
  useEffect(
    () => () => {
      void runnerRef.current?.stop("left the remote page");
    },
    []
  );

  const phase = runState.phase;
  const busy = phase.kind === "loading" || phase.kind === "running";

  const run = useCallback(
    async (p: LocalPolicy) => {
      if (!teleop) return;
      if (!runnerRef.current) {
        runnerRef.current = new PolicyRunner(baseUrl, () => telRef.current);
      }
      const runner = runnerRef.current;
      runner.onPhase = (ph) => setRunState({ ref: p.ref, phase: ph });
      const instruction = (instrByRef[p.ref] ?? "").trim();
      try {
        await runner.start(teleop, p.ref, {
          ...EXECUTION_PRESETS[mode],
          ...(instruction ? { instruction } : {}),
        });
      } catch (e) {
        toast({
          title: "Couldn't run on robot",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        });
      }
    },
    [baseUrl, teleop, toast, mode, instrByRef]
  );

  const stop = useCallback(() => {
    void runnerRef.current?.stop();
  }, []);

  if (!available) return unavailableNote ? <>{unavailableNote}</> : null;

  const runnable = policies.filter((p) => p.runnable);

  return (
    <div className={`rounded-md border border-nori-h14131a/10 bg-nori-hf3f1e8 px-4 pt-3 text-nori-h14131a shadow-sm ${open ? "pb-4" : "pb-3"}`}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className="flex min-h-9 cursor-pointer items-center justify-between"
      >
        <h3 className="text-base font-semibold leading-none tracking-tight">
          Deploy a policy
          <span className="ml-2 inline-flex -rotate-2 items-center rounded-full bg-sticker px-2 py-0.5 align-middle font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-ink shadow-soft">
            {"// beta"}
          </span>
          {busy && (
            <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-red-500 align-middle" />
          )}
        </h3>
        <span className="flex items-center gap-3 text-sm font-normal text-muted-foreground">
          {busy && <span className="text-xs">running</span>}
          {open ? "▲ hide" : "▼ show"}
        </span>
      </div>

      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-sm leading-relaxed text-nori-h6f6858">
            Run a trained policy on your robot. It runs on this computer and streams only motor
            instructions to Nori.
          </p>

          {runnable.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.18em] text-nori-hb06a1c">
                {"// execution"}
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                {(Object.keys(EXECUTION_PRESETS) as ExecutionMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    disabled={busy}
                    onClick={() => setMode(m)}
                    title={EXECUTION_MODE_LABELS[m].hint}
                    className={`rounded-full px-3 py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors disabled:opacity-50 ${
                      mode === m ? "bg-nori-hb06a1c text-white dark:text-neutral-900" : "bg-white/70 dark:bg-white/10 text-nori-h6f6858 hover:text-nori-h14131a"
                    }`}
                  >
                    {EXECUTION_MODE_LABELS[m].label}
                  </button>
                ))}
              </div>
              <span className="min-w-0 flex-1 text-[11px] leading-snug text-nori-h6f6858">
                {EXECUTION_MODE_LABELS[mode].hint}
              </span>
            </div>
          )}

          {runnable.length === 0 ? (
            <p className="text-sm text-nori-h6f6858">
              No policies downloaded yet — install one from the Marketplace and it'll appear here,
              ready to deploy.
            </p>
          ) : (
            <ul className="space-y-1">
              {runnable.map((p) => {
                const thisActive = runState.ref === p.ref && busy;
                const needsInstruction = LANGUAGE_POLICY_CLASSES.has(classByRef[p.ref] ?? "");
                const instruction = (instrByRef[p.ref] ?? "").trim();
                return (
                  <li
                    key={p.ref}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-nori-h14131a/10 py-1.5 first:border-t-0"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-nori-h14131a" title={p.ref}>
                      {nameFor(p.ref)}
                    </span>
                    {needsInstruction && (
                      <input
                        type="text"
                        value={instrByRef[p.ref] ?? ""}
                        disabled={busy}
                        onChange={(e) =>
                          setInstrByRef((m) => ({ ...m, [p.ref]: e.target.value }))
                        }
                        placeholder="instruction — e.g. pick up the cup"
                        title="This policy is language-conditioned: it does what you tell it to."
                        className="h-7 w-full min-w-0 flex-none rounded border border-nori-h14131a/20 bg-white/70 px-2 text-xs text-nori-h14131a placeholder:text-nori-h6f6858/60 disabled:opacity-50 dark:bg-white/10 sm:w-56 sm:flex-1"
                      />
                    )}
                    {thisActive ? (
                      <>
                        <span className="shrink-0 text-xs text-nori-h6f6858">
                          {phase.kind === "loading"
                            ? "loading…"
                            : `running · ${phase.kind === "running" ? phase.ticks : 0} ticks`}
                        </span>
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-7 shrink-0 px-2 text-xs"
                          onClick={stop}
                        >
                          Stop
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          className="h-7 shrink-0 px-3 text-xs"
                          disabled={!running || !teleop || busy || (needsInstruction && !instruction)}
                          title={needsInstruction && !instruction ? "Type an instruction first" : undefined}
                          onClick={() => void run(p)}
                        >
                          Run
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Remove ${nameFor(p.ref)} from this computer`}
                          title="Remove from this computer"
                          className="h-7 w-7 shrink-0 p-0 text-nori-h6f6858 hover:bg-destructive/10 hover:text-destructive"
                          disabled={busy}
                          onClick={() => setRemoving(p)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {phase.kind === "stopped" && (
            <p className="text-xs text-nori-h6f6858">Stopped — {phase.reason}</p>
          )}
          {phase.kind === "error" && <p className="text-xs text-red-700">{phase.message}</p>}
          {!running && runnable.length > 0 && (
            <p className="text-xs text-nori-h6f6858">Connect to the robot first to deploy a policy.</p>
          )}

          {/* Cloud VLA (MolmoAct2) — remote inference, own runner. Separate
              component so a restyle of this card doesn't collide with it.
              Gated dark (isCloudServeEnabled) while the serving lanes are rebuilt. */}
          {isCloudServeEnabled() && <CloudDeploySection />}
        </div>
      )}

      <AlertDialog
        open={!!removing}
        onOpenChange={(o) => {
          if (!o && !removeBusy) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove “{removing ? nameFor(removing.ref) : ""}” from this computer?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the downloaded copy from this computer's policy cache. The policy
              itself stays safe in your Nori cloud — you can re-install it from My Stuff any
              time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={removeBusy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault(); // keep the dialog open while the request runs
                void confirmRemove();
              }}
            >
              {removeBusy ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
