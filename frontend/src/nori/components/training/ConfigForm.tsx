// NORI: Additive file. Nori-styled training config form. Rebuilds LeLab's
// ConfigurationTab (Essentials / Compute / Advanced) with the warm Nori `Panel`
// visual language instead of LeLab's dark cards. The field set + defaults mirror
// lelab TrainingRequest so the whole config forwards cleanly to /jobs/training.

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import Panel from "@/nori/components/Panel";
import { Input } from "@/components/ui/input";
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

const DURATION_OPTIONS: { label: string; seconds: number }[] = [
  { label: "15 minutes", seconds: 900 },
  { label: "30 minutes", seconds: 1800 },
  { label: "60 minutes", seconds: 3600 },
];

const POLICY_OPTIONS: { value: string; label: string }[] = [
  { value: "act", label: "ACT (Action Chunking Transformer)" },
  { value: "diffusion", label: "Diffusion Policy" },
  { value: "pi0", label: "PI0" },
  { value: "smolvla", label: "SmolVLA" },
  { value: "tdmpc", label: "TD-MPC" },
  { value: "vqbet", label: "VQ-BeT" },
  { value: "pi0_fast", label: "PI0 Fast" },
  { value: "sac", label: "SAC" },
  { value: "reward_classifier", label: "Reward Classifier" },
];

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

  return (
    <div className="space-y-4">
      {/* Essentials */}
      <Panel eyebrow="dataset & policy" title="Run configuration">
        <div className="space-y-5">
          <div>
            <Label className={LABEL}>Dataset repository *</Label>
            <Input
              value={config.dataset_repo_id}
              onChange={(e) => updateConfig("dataset_repo_id", e.target.value)}
              placeholder="username/dataset"
              className={`mt-1 ${FIELD}`}
            />
            <p className="mt-1 text-xs text-[#14131a]/50">
              Defaults to your Nori dataset. Change it to train on another
              HuggingFace repo.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <Label className={LABEL}>Policy</Label>
              <Select
                value={config.policy_type}
                onValueChange={(v) => updateConfig("policy_type", v)}
              >
                <SelectTrigger className={`mt-1 ${FIELD}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {POLICY_OPTIONS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              onValueChange={(v) =>
                updateConfig("timeout_seconds", Number(v))
              }
            >
              <SelectTrigger className={`mt-1 ${FIELD}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DURATION_OPTIONS.map((d) => (
                  <SelectItem key={d.seconds} value={String(d.seconds)}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </Panel>

      {/* Advanced (collapsible) */}
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
            {/* Policy */}
            <section className="space-y-4">
              <h4 className={SUBHEAD}>Policy</h4>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <Label className={LABEL}>Device</Label>
                  <Select
                    value={config.policy_device || "cuda"}
                    onValueChange={(v) => updateConfig("policy_device", v)}
                  >
                    <SelectTrigger className={`mt-1 ${FIELD}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cuda">CUDA (GPU)</SelectItem>
                      <SelectItem value="cpu">CPU</SelectItem>
                      <SelectItem value="mps">MPS (Apple Silicon)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center space-x-3 pt-6">
                  <Switch
                    checked={config.policy_use_amp}
                    onCheckedChange={(c) => updateConfig("policy_use_amp", c)}
                  />
                  <Label className={LABEL}>Automatic mixed precision</Label>
                </div>
              </div>
            </section>

            {/* Training */}
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
              </div>
            </section>

            {/* Optimizer */}
            <section className="space-y-4">
              <h4 className={SUBHEAD}>Optimizer</h4>
              <div>
                <Label className={LABEL}>Optimizer</Label>
                <Select
                  value={config.optimizer_type || "adam"}
                  onValueChange={(v) => updateConfig("optimizer_type", v)}
                >
                  <SelectTrigger className={`mt-1 ${FIELD}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="adam">Adam</SelectItem>
                    <SelectItem value="adamw">AdamW</SelectItem>
                    <SelectItem value="sgd">SGD</SelectItem>
                    <SelectItem value="multi_adam">Multi Adam</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div>
                  <Label className={LABEL}>Learning rate</Label>
                  <NumberInput
                    integer={false}
                    step="0.0001"
                    value={config.optimizer_lr}
                    onChange={(v) => updateConfig("optimizer_lr", v)}
                    placeholder="Policy default"
                    className={`mt-1 ${FIELD}`}
                  />
                </div>
                <div>
                  <Label className={LABEL}>Weight decay</Label>
                  <NumberInput
                    integer={false}
                    step="0.0001"
                    value={config.optimizer_weight_decay}
                    onChange={(v) => updateConfig("optimizer_weight_decay", v)}
                    placeholder="Policy default"
                    className={`mt-1 ${FIELD}`}
                  />
                </div>
                <div>
                  <Label className={LABEL}>Gradient clipping</Label>
                  <NumberInput
                    integer={false}
                    step="0.0001"
                    value={config.optimizer_grad_clip_norm}
                    onChange={(v) => updateConfig("optimizer_grad_clip_norm", v)}
                    placeholder="Policy default"
                    className={`mt-1 ${FIELD}`}
                  />
                </div>
              </div>
            </section>

            {/* Logging & checkpointing */}
            <section className="space-y-4">
              <h4 className={SUBHEAD}>Logging & checkpointing</h4>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <Label className={LABEL}>Log frequency</Label>
                  <NumberInput
                    value={config.log_freq}
                    onChange={(v) => v !== undefined && updateConfig("log_freq", v)}
                    className={`mt-1 ${FIELD}`}
                  />
                </div>
                <div>
                  <Label className={LABEL}>Save frequency</Label>
                  <NumberInput
                    value={config.save_freq}
                    onChange={(v) => v !== undefined && updateConfig("save_freq", v)}
                    className={`mt-1 ${FIELD}`}
                  />
                </div>
              </div>
              <div className="flex items-center space-x-3">
                <Switch
                  checked={config.save_checkpoint}
                  onCheckedChange={(c) => updateConfig("save_checkpoint", c)}
                />
                <Label className={LABEL}>Save checkpoints</Label>
              </div>
              <div className="flex items-center space-x-3">
                <Switch
                  checked={config.resume}
                  onCheckedChange={(c) => updateConfig("resume", c)}
                />
                <Label className={LABEL}>Resume from checkpoint</Label>
              </div>
            </section>

            {/* Misc */}
            <section className="space-y-4">
              <h4 className={SUBHEAD}>Misc</h4>
              <div className="flex items-center space-x-3">
                <Switch
                  checked={config.use_policy_training_preset}
                  onCheckedChange={(c) =>
                    updateConfig("use_policy_training_preset", c)
                  }
                />
                <Label className={LABEL}>Use policy training preset</Label>
              </div>
            </section>
          </div>
        )}
      </Panel>
    </div>
  );
};

export default ConfigForm;
