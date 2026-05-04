import React, { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { useApi } from "@/contexts/ApiContext";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Loader2,
  XCircle,
} from "lucide-react";

type InstallState = "idle" | "installing" | "done" | "error";

interface LogEntry {
  timestamp: number;
  message: string;
}

interface InstallStatus {
  state: InstallState;
  error: string | null;
  logs: LogEntry[];
}

interface Props {
  installHint: string;
}

const POLL_INTERVAL_MS = 1500;

const TrainingExtraGate: React.FC<Props> = ({ installHint }) => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { toast } = useToast();

  const [state, setState] = useState<InstallState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logBoxRef = useRef<HTMLDivElement>(null);

  // Seed local state from the backend on mount so refresh-mid-install picks
  // up where we left off (or shows Done/Error if the install already finished).
  useEffect(() => {
    let cancelled = false;
    fetchWithHeaders(`${baseUrl}/system/training-extra/install-status`)
      .then((r) => r.json())
      .then((status: InstallStatus) => {
        if (cancelled) return;
        setState(status.state);
        setError(status.error);
        if (status.logs.length > 0) {
          setLogs(status.logs);
        }
      })
      .catch(() => {
        // Backend unreachable — stay in idle; the user can still try.
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchWithHeaders]);

  // Poll while installing.
  useEffect(() => {
    if (state !== "installing") return;
    const id = setInterval(async () => {
      try {
        const r = await fetchWithHeaders(`${baseUrl}/system/training-extra/install-status`);
        if (!r.ok) return;
        const status: InstallStatus = await r.json();
        if (status.logs && status.logs.length > 0) {
          setLogs((prev) => [...prev, ...status.logs]);
        }
        if (status.state !== "installing") {
          setState(status.state);
          setError(status.error);
        }
      } catch {
        // Transient errors are fine; we'll retry on next tick.
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [state, baseUrl, fetchWithHeaders]);

  // Auto-scroll the log panel as new lines arrive.
  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs]);

  const handleInstall = async () => {
    // Optimistically transition so the polling effect kicks in even if the
    // backend response is slow.
    setState("installing");
    setError(null);
    setLogs([]);
    try {
      const r = await fetchWithHeaders(`${baseUrl}/system/training-extra/install`, {
        method: "POST",
      });
      const body: { started: boolean; message: string } = await r.json();
      if (!body.started && r.ok) {
        // Backend says "already installing" — that's fine; polling already running.
        return;
      }
      if (!r.ok) {
        setState("error");
        setError(body.message || `Install request failed (${r.status})`);
      }
    } catch (e) {
      setState("error");
      setError(`Install request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleRetry = () => {
    setState("idle");
    setError(null);
    setLogs([]);
  };

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
    <div className="max-w-3xl mx-auto">
      <Card className="bg-slate-800/50 border-slate-700 rounded-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-3 text-white">
            {state === "done" ? (
              <CheckCircle2 className="w-6 h-6 text-green-400" />
            ) : state === "error" ? (
              <XCircle className="w-6 h-6 text-red-400" />
            ) : state === "installing" ? (
              <Loader2 className="w-6 h-6 text-sky-400 animate-spin" />
            ) : (
              <AlertTriangle className="w-6 h-6 text-amber-400" />
            )}
            {state === "done"
              ? "Install Complete"
              : state === "error"
              ? "Install Failed"
              : state === "installing"
              ? "Installing…"
              : "Training Extra Not Installed"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {state === "idle" && (
            <>
              <p className="text-slate-300">
                Training requires the <code className="px-1 py-0.5 rounded bg-slate-900 text-sky-300">accelerate</code> package, which isn't installed in this environment. Install it to enable the Training page.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 font-mono">
                  {installHint}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleCopy}
                  className="text-slate-400 hover:text-white"
                  aria-label="Copy install command"
                >
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
              <Button
                onClick={handleInstall}
                className="bg-green-500 hover:bg-green-600 text-white font-semibold"
              >
                Install Now
              </Button>
            </>
          )}

          {state === "installing" && (
            <p className="text-slate-300">
              Installing <code className="px-1 py-0.5 rounded bg-slate-900 text-sky-300">accelerate</code>. This usually takes about 10 seconds.
            </p>
          )}

          {state === "done" && (
            <p className="text-slate-300">
              Install complete. Restart <code className="px-1 py-0.5 rounded bg-slate-900 text-sky-300">lelab</code> (Ctrl+C in the terminal running it, then re-run <code className="px-1 py-0.5 rounded bg-slate-900 text-sky-300">lelab --dev</code> or <code className="px-1 py-0.5 rounded bg-slate-900 text-sky-300">lelab</code>) to enable training.
            </p>
          )}

          {state === "error" && (
            <>
              <p className="text-red-300">{error || "Install failed."}</p>
              <Button
                onClick={handleRetry}
                className="bg-slate-700 hover:bg-slate-600 text-white"
              >
                Try again
              </Button>
            </>
          )}

          {state === "error" && logs.length > 0 && (
            <div
              ref={logBoxRef}
              className="bg-slate-900 rounded-lg p-3 h-48 overflow-y-auto font-mono text-xs border border-slate-700 text-slate-300 whitespace-pre-wrap break-words"
            >
              {logs.map((log, idx) => (
                <div key={idx}>{log.message}</div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default TrainingExtraGate;
