// NORI: Policy scope picker. Lets the user target a policy at specific arms and
// cameras. The resulting scope rides on the dispatch (DispatchRequest.scope);
// the container subsets the dataset before training and stamps the resolved
// scope into nori_meta.json, and rollout then feeds only those cameras and
// commands only those joints (the daemon holds the rest). Camera/arm options are
// DATA-DRIVEN from the selected dataset's features so we never offer something
// that isn't recorded (which would fail the job).

import { useEffect, useState } from "react";
import Panel from "@/nori/components/Panel";
import { useApi } from "@/contexts/ApiContext";
import { getDatasetScopeOptions } from "@/nori/api/client";
import type { NoriTrainingFormState } from "./types";

interface ScopePanelProps {
  config: NoriTrainingFormState;
  updateConfig: <T extends keyof NoriTrainingFormState>(
    key: T,
    value: NoriTrainingFormState[T],
  ) => void;
}

type ArmChoice = "whole" | "left" | "right";

const armFromScope = (actuators?: string[]): ArmChoice => {
  if (!actuators || actuators.length === 0) return "whole";
  if (actuators.length === 1 && actuators[0] === "left") return "left";
  if (actuators.length === 1 && actuators[0] === "right") return "right";
  return "whole";
};

// Default cameras for an arm: overhead + that arm's wrist, if recorded.
const defaultCamsFor = (arm: ArmChoice, available: string[]): string[] => {
  if (arm === "whole") return [];
  const want = ["overhead", `${arm}_wrist`];
  return available.filter((c) => want.includes(c));
};

const ScopePanel = ({ config, updateConfig }: ScopePanelProps) => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [cameras, setCameras] = useState<string[]>([]);
  const [arms, setArms] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  // Load the selected dataset's recorded cameras/arms.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getDatasetScopeOptions(baseUrl, fetchWithHeaders, config.dataset_ref)
      .then((opts) => {
        if (cancelled) return;
        setCameras(opts.cameras || []);
        setArms(opts.arms || []);
      })
      .catch(() => {
        if (!cancelled) {
          setCameras([]);
          setArms([]);
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchWithHeaders, config.dataset_ref, config.open_dataset_id]);

  const arm = armFromScope(config.scope?.actuators);
  const selectedCams = config.scope?.cameras ?? [];

  // Prune an all-defaults scope back to undefined (= whole robot, all cameras).
  const commit = (actuators: string[], cams: string[]) => {
    const scope =
      actuators.length === 0 && cams.length === 0
        ? undefined
        : {
            ...(actuators.length ? { actuators } : {}),
            ...(cams.length ? { cameras: cams } : {}),
          };
    updateConfig("scope", scope);
  };

  const chooseArm = (next: ArmChoice) => {
    const actuators = next === "whole" ? [] : [next];
    // Seed sensible camera defaults when narrowing to one arm and nothing set.
    const cams =
      next !== "whole" && selectedCams.length === 0
        ? defaultCamsFor(next, cameras)
        : selectedCams;
    commit(actuators, cams);
  };

  const toggleCam = (cam: string) => {
    const next = selectedCams.includes(cam)
      ? selectedCams.filter((c) => c !== cam)
      : [...selectedCams, cam];
    commit(arm === "whole" ? [] : [arm], next);
  };

  const armOptions: { key: ArmChoice; label: string; disabled?: boolean }[] = [
    { key: "whole", label: "Whole robot" },
    { key: "left", label: "Left arm", disabled: arms.length > 0 && !arms.includes("left") },
    { key: "right", label: "Right arm", disabled: arms.length > 0 && !arms.includes("right") },
  ];

  return (
    <Panel eyebrow="scope" title="Policy scope (optional)">
      <p className="mb-3 text-xs text-[#14131a]/60">
        Target the policy at specific arms and cameras. Fewer, well-placed
        cameras mean faster on-laptop inference and less overfitting. Leave as
        “Whole robot” to train on everything recorded.
      </p>

      {/* Arms */}
      <div className="mb-4">
        <div className="mb-1.5 text-xs font-semibold text-[#14131a]/70">Arms</div>
        <div className="flex flex-wrap gap-2">
          {armOptions.map((opt) => {
            const active = arm === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                disabled={opt.disabled}
                onClick={() => chooseArm(opt.key)}
                className={[
                  "rounded-md border px-3 py-1.5 text-sm transition-colors",
                  active
                    ? "border-[#b06a1c] bg-[#b06a1c]/10 text-[#b06a1c] font-semibold"
                    : "border-[#14131a]/15 text-[#14131a]/70 hover:border-[#14131a]/30",
                  opt.disabled ? "cursor-not-allowed opacity-40" : "",
                ].join(" ")}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Cameras */}
      <div>
        <div className="mb-1.5 text-xs font-semibold text-[#14131a]/70">
          Cameras{" "}
          <span className="font-normal text-[#14131a]/40">
            {selectedCams.length === 0 ? "(all recorded)" : `(${selectedCams.length} selected)`}
          </span>
        </div>
        {loading ? (
          <div className="text-xs text-[#14131a]/40">Loading dataset cameras…</div>
        ) : cameras.length === 0 ? (
          <div className="text-xs text-[#14131a]/40">
            No camera metadata for this dataset — the policy will use all recorded cameras.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {cameras.map((cam) => {
              const on = selectedCams.includes(cam);
              return (
                <button
                  key={cam}
                  type="button"
                  onClick={() => toggleCam(cam)}
                  className={[
                    "rounded-md border px-3 py-1.5 text-sm transition-colors",
                    on
                      ? "border-[#2f7d5b] bg-[#2f7d5b]/10 text-[#2f7d5b] font-semibold"
                      : "border-[#14131a]/15 text-[#14131a]/70 hover:border-[#14131a]/30",
                  ].join(" ")}
                >
                  {on ? "✓ " : ""}
                  {cam}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
};

export default ScopePanel;
