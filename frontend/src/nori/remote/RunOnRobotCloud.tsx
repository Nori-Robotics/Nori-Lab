// NORI: Additive file. "Run on robot (cloud)" — robot-DIRECT cloud inference
// (Nori-Backend ROBOT_DIRECT_INFERENCE_DESIGN.md). Unlike PolicyDeployCard
// (desktop-only: runs the policy on THIS computer via lelab) and
// CloudDeploySection (laptop-hosted chunk-queue loop), this asks the BACKEND
// to start a session: the backend spawns the Modal serve container and the
// robot's own cloud_rollout_agent fetches the grant and runs the loop.
// Nothing executes in this browser — the laptop can close once ACTIVE. Works
// on the hosted app (no lelab required), which is why it's the deploy card the
// hosted site can actually show.
//
// Shadow slice: the robot streams live vision and the policy runs, but the
// driver never drives the arm (motion is a later, separately-gated layer).
import { useCallback, useEffect, useRef, useState } from "react";

import { useApi } from "@/contexts/ApiContext";
import { useTeleopSession } from "@/nori/TeleopSessionContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  getInferenceSession,
  startInferenceSession,
  stopInferenceSession,
  type InferenceSession,
} from "@/nori/api/client";

const LIVE = new Set(["PENDING", "ACTIVE"]);

export function RunOnRobotCloud() {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { running, settings } = useTeleopSession();
  const { toast } = useToast();
  const [session, setSession] = useState<InferenceSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [instruction, setInstruction] = useState("pick up the cup");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The session room IS the paired robot's serial (room-token retirement),
  // same source CloudDeploySection uses.
  const robotSerial = settings.room.trim();
  const live = session != null && LIVE.has(session.status);

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
        policy_kind: "molmoact2",
        instruction,
        views: ["right_wrist", "overhead"],
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
  }, [baseUrl, fetchWithHeaders, robotSerial, instruction, toast]);

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

  // Only meaningful once connected to a robot (the room/serial is known).
  if (!running || !robotSerial) return null;

  return (
    <div className="rounded-md border border-nori-h14131a/10 bg-nori-hf3f1e8 p-4 text-nori-h14131a shadow-sm">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-nori-hb06a1c">
        // cloud policy (runs on the robot)
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        Run a cloud policy directly on <span className="font-semibold">{robotSerial}</span> — the
        robot streams to the cloud and back on its own. You can close this laptop once it's live.
      </p>
      <input
        className="mt-3 w-full rounded border border-nori-h14131a/20 bg-background px-2 py-1 text-sm"
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="Instruction (e.g. pick up the cup)"
        disabled={live}
      />
      <div className="mt-3">
        {live ? (
          <Button variant="outline" size="sm" onClick={stop} disabled={busy}>
            Stop cloud rollout
          </Button>
        ) : (
          <Button size="sm" onClick={start} disabled={busy}>
            Run on robot (cloud)
          </Button>
        )}
      </div>
      {session && (
        <p className="mt-2 text-xs text-muted-foreground">
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
