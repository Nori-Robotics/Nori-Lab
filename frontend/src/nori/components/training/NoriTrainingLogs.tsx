// NORI: Additive file. Nori-styled log panel for the training monitor. Same
// structure as components/training/monitoring/TrainingLogs.tsx, warm palette.

import type { ReactNode, RefObject } from "react";
import Panel from "@/nori/components/Panel";
import type { LogLine } from "@/lib/jobsApi";

interface NoriTrainingLogsProps {
  logs: LogLine[];
  logContainerRef: RefObject<HTMLDivElement>;
  /** Optional control rendered top-right (e.g. a "Load full logs" button). */
  headerAction?: ReactNode;
}

const NoriTrainingLogs = ({ logs, logContainerRef, headerAction }: NoriTrainingLogsProps) => (
  <Panel eyebrow="logs" title="Training logs">
    {headerAction && <div className="mb-2 flex justify-end">{headerAction}</div>}
    <div
      ref={logContainerRef}
      className="h-96 overflow-y-auto rounded-md border border-nori-h14131a/10 bg-white dark:bg-background p-4 font-mono text-sm"
    >
      {logs.length === 0 ? (
        <div className="py-8 text-nori-h14131a/50">
          No training logs yet. Start training to see output.
        </div>
      ) : (
        logs.map((log, i) => (
          <div key={i} className="whitespace-pre-wrap break-words text-nori-h14131a/80">
            {log.timestamp > 0 && (
              <span className="mr-2 select-none text-nori-h14131a/40">
                {new Date(log.timestamp * 1000).toLocaleTimeString()}
              </span>
            )}
            {log.message}
          </div>
        ))
      )}
    </div>
  </Panel>
);

export default NoriTrainingLogs;
