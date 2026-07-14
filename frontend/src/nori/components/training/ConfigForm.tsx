// NORI: Nori-styled training config form. Shows ONLY the settings Nori-Backend's
// DispatchRequest actually honors for a cloud run (policy is ACT-only, dataset is
// one of your promoted uploads, plus steps/batch/duration and a few advanced
// knobs). Everything the backend forces or doesn't consume yet is parked in
// ./parkedConfig.ts and omitted here — see that file to re-surface a field.

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import Panel from "@/nori/components/Panel";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { NoriTrainingFormState } from "./types";
import { FEASIBLE_POLICY_OPTIONS, DURATION_OPTIONS } from "./types";

// Warm-palette field styling, matching the Panel cream/ink language.
const FIELD = "border-[#14131a]/15 bg-white text-[#14131a] rounded-md";
const LABEL = "text-[#14131a]/70";
const SUBHEAD =
  "font-mono text-[11px] uppercase tracking-[0.18em] text-[#b06a1c]";

const LATEST = "__latest__"; // sentinel for "use my latest promoted upload"

export interface DatasetOption {
  ref: string; // backend dataset_ref (promoted upload prefix)
  label: string;
}

export interface ConfigFormProps {
  config: NoriTrainingFormState;
  updateConfig: <T extends keyof NoriTrainingFormState>(
    key: T,
    value: NoriTrainingFormState[T],
  ) => void;
  /** The customer's promoted datasets, for the dataset_ref dropdown. */
  datasets?: DatasetOption[];
}

const ConfigForm = ({ config, updateConfig, datasets = [] }: ConfigFormProps) => {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="space-y-4">
      {/* Essentials */}
      <Panel eyebrow="dataset & policy" title="Run configuration">
        <div className="space-y-5">
          <div>
            <Label className={LABEL}>Dataset</Label>
            <Select
              value={config.dataset_ref ?? LATEST}
              onValueChange={(v) =>
                updateConfig("dataset_ref", v === LATEST ? undefined : v)
              }
            >
              <SelectTrigger className={`mt-1 ${FIELD}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={LATEST}>Latest upload (default)</SelectItem>
                {datasets.map((d) => (
                  <SelectItem key={d.ref} value={d.ref}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-[#14131a]/50">
              Training runs on one of your uploaded Nori datasets. Defaults to
              your most recent upload.
            </p>
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
                {DURATION_OPTIONS.map((d) => (
                  <SelectItem key={d.seconds} value={String(d.seconds)} disabled={d.pro}>
                    {d.label}
                    {d.pro ? " · Pro" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-[#14131a]/50">
              Free tier includes 15-minute runs. Longer runs need a Pro plan.
            </p>
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
