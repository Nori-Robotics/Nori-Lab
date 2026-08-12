// NORI: Additive file. "Run on robot (cloud)" — robot-DIRECT cloud inference
// (Nori-Backend ROBOT_DIRECT_INFERENCE_DESIGN.md, P2 shadow slice). Unlike
// CloudDeploySection (which runs the chunk-queue loop on THIS laptop), this
// button only asks the backend to start a session: the backend spawns the
// Modal serve container and the robot's own cloud_rollout_agent fetches the
// grant and runs the loop. Nothing executes in this browser, and the laptop
// can be closed the moment the session is ACTIVE.
//
// Shadow slice: no motion — the robot streams live vision and the policy runs,
// but the driver never drives the arm (a later, separately-gated layer).
import { useCallback, useEffect, useRef, useState } from "react";

import { useApi } from "@/contexts/ApiContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  getInferenceSession,
  startInferenceSession,
  stopInferenceSession,
  type InferenceSession,
} from "@/nori/api/client";

interface Props {
  robotSerial: string;
  policyKind?: string;
  instruction?: string;
  views?: string[];
}

const LIVE = new Set(["PENDING", "ACTIVE"]);

export function RunOnRobotCloud({
  robotSerial,
  policyKind = "molmoact2",
  instruction = "pick up the cup",
  views = ["right_wrist", "overhead"],
}: Props) {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { toast } = useToast();
  const [session, setSession] = useState<InferenceSession | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const live = session != null && LIVE.has(session.status);

  // Poll while the session is live so the label reflects PENDING -> ACTIVE ->
  // terminal without the operator refreshing.
  useEffect(() => {
    if (!session || !LIVE.has(session.status)) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        setSession(await getInferenceSession(baseUrl, fetchWithHeaders, session.session_id));
      } catch {
        /* transient — next tick retries */
      }
    }, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [session, baseUrl, fetchWithHeaders]);

  const start = useCallback(async () => {
    setBusy(true);
    try {
      const s = await startInferenceSession(baseUrl, fetchWithHeaders, {
        robot_serial: robotSerial,
        policy_kind: policyKind,
        instruction,
        views,
      });
      setSession(s);
      toast({
        title: "Cloud rollout starting",
        description:
          "The robot is connecting to the cloud policy on its own — you can close this laptop.",
      });
    } catch (e) {
      toast({
        title: "Couldn't start cloud rollout",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }, [baseUrl, fetchWithHeaders, robotSerial, policyKind, instruction, views, toast]);

  const stop = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    try {
      setSession(await stopInferenceSession(baseUrl, fetchWithHeaders, session.session_id));
    } catch (e) {
      toast({
        title: "Couldn't stop",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }, [baseUrl, fetchWithHeaders, session, toast]);

  return (
    <div className="flex flex-col gap-1.5">
      {live ? (
        <Button variant="outline" size="sm" onClick={stop} disabled={busy}>
          Stop cloud rollout
        </Button>
      ) : (
        <Button size="sm" onClick={start} disabled={busy || !robotSerial}>
          Run on robot (cloud)
        </Button>
      )}
      {session && (
        <p className="text-xs text-muted-foreground">
          {session.status === "PENDING"
            ? "Waiting for the robot to connect…"
            : session.status === "ACTIVE"
              ? "Live — robot is running the cloud policy (laptop not needed)."
              : session.status === "FAILED"
                ? `Failed: ${session.failure_reason ?? "unknown"}`
                : `Session ${session.status.toLowerCase()}.`}
        </p>
      )}
    </div>
  );
}
