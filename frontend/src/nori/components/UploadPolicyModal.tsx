// NORI: upload your own policy (a LeRobot pretrained bundle) into your Nori cloud.
// Provide a .tar.gz of the bundle (model.safetensors + config.json + processors) plus a
// little deploy metadata; the backend runs the strict gate stack (safetensors-only, no
// remote code, PII scrub) and promotes it to a PRIVATE policy — deployable on your own
// robot + downloadable, but NEVER publishable (uploaded != pipeline-trained).
//
// Bundle bytes go browser -> S3 directly via a presigned PUT (needs a bucket CORS rule
// for uploads — see the backend storage/verify_aws_setup.py checklist); the metadata
// and finalize/poll calls go through the backend.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Loader2, UploadCloud, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApi } from "@/contexts/ApiContext";
import {
  finalizePolicyUpload,
  getPolicyUpload,
  putPolicyBundle,
  startPolicyUpload,
  type PolicyUploadMeta,
} from "@/nori/api/client";

type Phase = "form" | "working" | "done" | "error";

export function UploadPolicyModal({
  onClose,
  onUploaded,
}: {
  onClose: () => void;
  onUploaded?: (jobId: string) => void;
}) {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [phase, setPhase] = useState<Phase>("form");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [views, setViews] = useState("right_wrist, overhead");
  const [arm, setArm] = useState("right");
  const [fps, setFps] = useState("15");
  const [instruction, setInstruction] = useState("");
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);

  const submit = useCallback(async () => {
    if (!file) {
      setError("Choose a .tar.gz bundle first.");
      return;
    }
    setError(null);
    setPhase("working");
    try {
      const meta: PolicyUploadMeta = {
        title: title.trim() || file.name.replace(/\.(tar\.gz|tgz)$/i, ""),
        views: views.split(",").map((v) => v.trim()).filter(Boolean),
        arm: arm.trim() || null,
        fps: fps.trim() ? Number(fps) : null,
        instruction: instruction.trim() || null,
      };
      setStatusText("Opening upload…");
      const start = await startPolicyUpload(baseUrl, fetchWithHeaders, meta);
      if (cancelled.current) return;
      setStatusText("Uploading bundle…");
      await putPolicyBundle(start.put_url, file);
      if (cancelled.current) return;
      setStatusText("Checking + promoting…");
      await finalizePolicyUpload(baseUrl, fetchWithHeaders, start.upload_id);
      for (;;) {
        if (cancelled.current) return;
        await new Promise((r) => setTimeout(r, 2500));
        if (cancelled.current) return;
        const s = await getPolicyUpload(baseUrl, fetchWithHeaders, start.upload_id);
        if (s.status === "PROMOTED") {
          setPhase("done");
          if (s.result_job_id) onUploaded?.(s.result_job_id);
          return;
        }
        if (s.status === "FAILED") {
          setError(s.failure_reason || "Upload was rejected by the safety checks.");
          setPhase("error");
          return;
        }
      }
    } catch (e) {
      if (cancelled.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [file, title, views, arm, fps, instruction, baseUrl, fetchWithHeaders, onUploaded]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-[20px] bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-bold text-nori-h14131a">Upload a policy</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-nori-h14131a" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          A LeRobot policy bundle (<code>.tar.gz</code> of model.safetensors + config.json +
          processors). It stays private to you — deployable on your robot and downloadable,
          but not publishable.
        </p>

        {phase === "form" && (
          <div className="mt-5 flex flex-col gap-3">
            <div>
              <Label htmlFor="pol-file">Bundle (.tar.gz)</Label>
              <Input id="pol-file" type="file" accept=".tar.gz,.tgz,application/gzip"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>
            <div>
              <Label htmlFor="pol-title">Name</Label>
              <Input id="pol-title" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="My uploaded policy" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="pol-arm">Arm</Label>
                <Input id="pol-arm" value={arm} onChange={(e) => setArm(e.target.value)} placeholder="right" />
              </div>
              <div>
                <Label htmlFor="pol-fps">fps</Label>
                <Input id="pol-fps" type="number" value={fps} onChange={(e) => setFps(e.target.value)} />
              </div>
            </div>
            <div>
              <Label htmlFor="pol-views">Cameras (comma-separated)</Label>
              <Input id="pol-views" value={views} onChange={(e) => setViews(e.target.value)}
                placeholder="right_wrist, overhead" />
            </div>
            <div>
              <Label htmlFor="pol-instr">Instruction (optional)</Label>
              <Input id="pol-instr" value={instruction} onChange={(e) => setInstruction(e.target.value)}
                placeholder="e.g. pick up the cup" />
            </div>
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            <Button onClick={submit} disabled={!file} className="mt-1 w-full gap-2">
              <UploadCloud className="h-4 w-4" /> Upload
            </Button>
          </div>
        )}

        {phase === "working" && (
          <div className="mt-6 flex flex-col items-center gap-3 py-6 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-nori-h14131a" />
            <p className="text-sm text-muted-foreground">{statusText || "Working…"}</p>
            <p className="text-xs text-muted-foreground">
              Safety checks run in your cloud; large bundles take a moment.
            </p>
          </div>
        )}

        {phase === "done" && (
          <div className="mt-6 flex flex-col items-center gap-3 py-6 text-center">
            <CheckCircle2 className="h-7 w-7 text-green-600" />
            <p className="text-sm text-nori-h14131a">Policy uploaded — it's in My Stuff now.</p>
            <Button onClick={onClose} className="w-full">Done</Button>
          </div>
        )}

        {phase === "error" && (
          <div className="mt-6">
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPhase("form")}>Back</Button>
              <Button onClick={onClose}>Close</Button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
