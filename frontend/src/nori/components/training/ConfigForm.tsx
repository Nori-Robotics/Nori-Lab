// NORI: Nori-styled training config form. Shows ONLY the settings Nori-Backend's
// DispatchRequest actually honors for a cloud run (policy is ACT-only, dataset is
// one of your promoted uploads, plus steps/batch/duration and a few advanced
// knobs). Everything the backend forces or doesn't consume yet is parked in
// ./parkedConfig.ts and omitted here — see that file to re-surface a field.

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import Panel from "@/nori/components/Panel";
import { NumberInput } from "@/components/ui/number-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useApi } from "@/contexts/ApiContext";
import {
  getTrainingEstimateParams,
  type TrainingEstimateParams,
} from "@/nori/api/client";
import type { NoriTrainingFormState } from "./types";
import { FEASIBLE_POLICY_OPTIONS, DURATION_OPTIONS, UNLIMITED_DURATION_SECONDS } from "./types";

// Warm-palette field styling, matching the Panel cream/ink language.
const FIELD = "border-[#14131a]/15 bg-white text-[#14131a] rounded-md";
const LABEL = "text-[#14131a]/70";
const SUBHEAD =
  "font-mono text-[11px] uppercase tracking-[0.18em] text-[#b06a1c]";

export interface ConfigFormProps {
  config: NoriTrainingFormState;
  updateConfig: <T extends keyof NoriTrainingFormState>(
    key: T,
    value: NoriTrainingFormState[T],
  ) => void;
}

const ConfigForm = ({ config, updateConfig }: ConfigFormProps) => {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Live training-time estimate. The constants come from the backend (same
  // table the dispatch fit-gate reads) so this panel can never promise what
  // dispatch would reject. Best-effort: on fetch failure the estimate simply
  // doesn't render — the form still works.
  const { baseUrl, fetchWithHeaders } = useApi();
  const [estParams, setEstParams] = useState<TrainingEstimateParams | null>(null);
  useEffect(() => {
    let alive = true;
    getTrainingEstimateParams(baseUrl, fetchWithHeaders)
      .then((p) => alive && setEstParams(p))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [baseUrl, fetchWithHeaders]);

  const estimate = useMemo(() => {
    const rates = estParams?.step_rates[config.policy_type];
    if (!rates || !config.steps) return null;
    const fastMin = Math.ceil(config.steps / rates.typical / 60);
    const slowMin = Math.ceil(config.steps / rates.floor / 60);
    const requiredSeconds = Math.ceil(config.steps / rates.floor);
    return {
      fastMin,
      slowMin,
      setupMin: Math.round((estParams?.setup_seconds ?? 0) / 60),
      fits: requiredSeconds <= config.timeout_seconds,
      maxFittingSteps: config.timeout_seconds * rates.floor,
    };
  }, [estParams, config.policy_type, config.steps, config.timeout_seconds]);

  // Largest selectable "Max training duration" for this customer's tier (from
  // the estimate endpoint: free 900s, pro 3600s, developer unlimited). Options
  // above it are disabled. Conservative 900 until the estimate loads.
  const maxDuration = estParams?.max_timeout_seconds ?? 900;

  return (
    <div className="space-y-4">
      {/* Essentials */}
      <Panel eyebrow="policy" title="Run configuration">
        <div className="space-y-5">
          <div>
            <Label className={LABEL}>Policy name</Label>
            <Input
              value={config.policy_name ?? ""}
              onChange={(e) => updateConfig("policy_name", e.target.value || undefined)}
              maxLength={120}
              placeholder="optional — e.g. Grab the red cup (rename anytime from My Stuff)"
              className={`mt-1 ${FIELD}`}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <Label className={LABEL}>Policy</Label>
              <Select value={config.policy_type} onValueChange={(v) => updateConfig("policy_type", v)}>
                <SelectTrigger className={`mt-1 ${FIELD}`} disabled={FEASIBLE_POLICY_OPTIONS.length < 2}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FEASIBLE_POLICY_OPTIONS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-[#14131a]/50">
                More architectures coming soon.
              </p>
            </div>
            <div>
              <Label className={LABEL}>Training steps</Label>
              <NumberInput
                value={config.steps}
                onChange={(v) => v !== undefined && updateConfig("steps", v)}
                className={`mt-1 ${FIELD}`}
              />
              {estimate && (
                <p className="mt-1 text-xs text-[#14131a]/50">
                  Estimated training ≈ {estimate.fastMin}–{estimate.slowMin} min
                  {estimate.setupMin > 0 && (
                    <> (+ ~{estimate.setupMin} min setup, not billed to you)</>
                  )}
                </p>
              )}
            </div>
            <div>
              <Label className={LABEL}>Batch size</Label>
              <NumberInput
                value={config.batch_size}
                onChange={(v) => v !== undefined && updateConfig("batch_size", v)}
                className={`mt-1 ${FIELD}`}
              />
            </div>
          </div>
        </div>
      </Panel>

      {/* Compute */}
      <Panel eyebrow="compute" title="Where it runs">
        <div className="space-y-3">
          <p className="text-sm text-[#14131a]/70">
            Training runs on Nori cloud compute — no setup, no HuggingFace token
            needed. The trained policy is saved to your account when it finishes.
          </p>
          <div className="max-w-xs">
            <Label className={LABEL}>Max training duration</Label>
            <Select
              value={String(config.timeout_seconds)}
              onValueChange={(v) => updateConfig("timeout_seconds", Number(v))}
            >
              <SelectTrigger className={`mt-1 ${FIELD}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DURATION_OPTIONS.map((d) => {
                  const locked = d.seconds > maxDuration;
                  return (
                    <SelectItem key={d.seconds} value={String(d.seconds)} disabled={locked}>
                      {d.label}
                      {locked ? " · upgrade" : ""}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-[#14131a]/50">
              {maxDuration >= UNLIMITED_DURATION_SECONDS
                ? "Your plan includes unlimited training duration."
                : "Longer runs unlock on higher plans — Developer tier is unlimited."}
            </p>
            {estimate && !estimate.fits && (
              estParams?.resumable ? (
                <p className="mt-2 rounded bg-[#3d6ea5]/10 px-2 py-1.5 text-xs text-[#2c5282]">
                  This training is longer than the selected duration (≈
                  {estimate.slowMin} min needed). It will pause safely when the
                  duration runs out and can be resumed later from where it left
                  off.
                </p>
              ) : (
                <p className="mt-2 rounded bg-[#b06a1c]/15 px-2 py-1.5 text-xs text-[#7a4a13]">
                  Won't finish in this duration: ≈{estimate.slowMin} min needed.
                  Dispatch will reject this — reduce steps to at most{" "}
                  {estimate.maxFittingSteps.toLocaleString()} or pick a longer
                  duration.
                </p>
              )
            )}
          </div>
        </div>
      </Panel>

      {/* Advanced (collapsible) — only backend-honored knobs remain here */}
      <Panel className="p-0">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
          className="flex w-full items-center justify-between p-4 text-left"
        >
          <span className="font-semibold text-[#14131a]">Advanced</span>
          <span className="flex items-center gap-1 text-sm text-[#14131a]/60">
            {advancedOpen ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            {advancedOpen ? "Hide" : "Show"}
          </span>
        </button>

        {advancedOpen && (
          <div className="space-y-8 border-t border-[#14131a]/10 p-4">
            <section className="space-y-4">
              <h4 className={SUBHEAD}>Training</h4>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <Label className={LABEL}>Random seed</Label>
                  <NumberInput
                    value={config.seed}
                    onChange={(v) => updateConfig("seed", v)}
                    className={`mt-1 ${FIELD}`}
                  />
                </div>
                <div>
                  <Label className={LABEL}>Number of workers</Label>
                  <NumberInput
                    value={config.num_workers}
                    onChange={(v) => v !== undefined && updateConfig("num_workers", v)}
                    className={`mt-1 ${FIELD}`}
                  />
                </div>
                <div className="flex items-center space-x-3 pt-6">
                  <Switch
                    checked={config.policy_use_amp}
                    onCheckedChange={(c) => updateConfig("policy_use_amp", c)}
                  />
                  <Label className={LABEL}>Automatic mixed precision</Label>
                </div>
                <div>
                  <Label className={LABEL}>Log frequency</Label>
                  <NumberInput
                    value={config.log_freq}
                    onChange={(v) => v !== undefined && updateConfig("log_freq", v)}
                    className={`mt-1 ${FIELD}`}
                  />
                </div>
              </div>
            </section>
          </div>
        )}
      </Panel>
    </div>
  );
};

export default ConfigForm;
