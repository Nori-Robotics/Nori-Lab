import React from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Loader2,
  XCircle,
} from "lucide-react";
import type { InstallState, LogEntry } from "@/hooks/useInstallExtra";

interface InstallProgressProps {
  state: InstallState;
  error: string | null;
  logs: LogEntry[];
  logBoxRef: React.RefObject<HTMLDivElement>;
  onInstall: () => void;
  onRetry: () => void;

  installHint: string;
  packageName: string;
  idleTitle: string;
  idleDescription: React.ReactNode;
  doneDescription: React.ReactNode;
}

export function installTitle(state: InstallState, idleTitle: string): string {
  switch (state) {
    case "done":
      return "Install Complete";
    case "error":
      return "Install Failed";
    case "installing":
      return "Installing…";
    default:
      return idleTitle;
  }
}

export function InstallTitleIcon({ state }: { state: InstallState }) {
  if (state === "done") return <CheckCircle2 className="w-6 h-6 text-green-600" />;
  if (state === "error") return <XCircle className="w-6 h-6 text-red-600" />;
  if (state === "installing")
    return <Loader2 className="w-6 h-6 text-sky-600 animate-spin" />;
  return <AlertTriangle className="w-6 h-6 text-amber-600" />;
}

export const InstallProgress: React.FC<InstallProgressProps> = ({
  state,
  error,
  logs,
  logBoxRef,
  onInstall,
  onRetry,
  installHint,
  packageName,
  idleDescription,
  doneDescription,
}) => {
  const { toast } = useToast();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(installHint);
      toast({ title: "Copied", description: installHint });
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the command and copy manually.",
        variant: "destructive",
      });
    }
  };

  return (
    <>
      {state === "idle" && (
        <>
          <p className="text-muted-foreground">{idleDescription}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-card border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono">
              {installHint}
            </code>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleCopy}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Copy install command"
            >
              <Copy className="w-4 h-4" />
            </Button>
          </div>
          <Button
            onClick={onInstall}
            className="bg-[#8ab135] hover:bg-[#799c2a] text-white font-semibold"
          >
            Install Now
          </Button>
        </>
      )}

      {state === "installing" && (
        <p className="text-muted-foreground">
          Installing{" "}
          <code className="px-1 py-0.5 rounded bg-card text-sky-700">
            {packageName}
          </code>
          . This usually takes about 10 seconds.
        </p>
      )}

      {state === "done" && (
        <div className="space-y-3 text-muted-foreground">{doneDescription}</div>
      )}

      {state === "error" && (
        <>
          <p className="text-red-700">{error || "Install failed."}</p>
          <Button
            onClick={onRetry}
            className="bg-muted hover:bg-muted text-foreground"
          >
            Try again
          </Button>
        </>
      )}

      {state === "error" && logs.length > 0 && (
        <div
          ref={logBoxRef}
          className="bg-card rounded-lg p-3 h-48 overflow-y-auto font-mono text-xs border border-border text-muted-foreground whitespace-pre-wrap break-words"
        >
          {logs.map((log, idx) => (
            <div key={idx}>{log.message}</div>
          ))}
        </div>
      )}
    </>
  );
};

export const RestartInstructions: React.FC<{ purpose: string }> = ({
  purpose,
}) => (
  <>
    <p>
      Install complete. Restart{" "}
      <code className="px-1 py-0.5 rounded bg-card text-sky-700">
        lelab
      </code>{" "}
      to enable {purpose}:
    </p>
    <ol className="list-decimal list-inside space-y-2 pl-1">
      <li>
        Press{" "}
        <kbd className="px-1.5 py-0.5 rounded bg-card border border-border text-xs font-mono text-foreground">
          Ctrl+C
        </kbd>{" "}
        in the terminal running{" "}
        <code className="px-1 py-0.5 rounded bg-card text-sky-700">
          lelab
        </code>
        .
      </li>
      <li>
        Run{" "}
        <code className="px-1 py-0.5 rounded bg-card text-sky-700">
          lelab
        </code>{" "}
        again.
      </li>
    </ol>
  </>
);
