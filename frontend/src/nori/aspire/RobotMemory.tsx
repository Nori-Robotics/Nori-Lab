// NORI: what the hosted agent has learned on a robot (its memory): the context facts and the topic entries it wrote at
// the end of earlier runs (nori-policy-agent synthesis/aspire_service/advice.py), served by the backend from
// aspire_robot_notes (migration 059). Read-only text plus three actions per entry: retract (it leaves the next
// task's prompt; its text goes to the changelog), edit one field, promote (marked; the entry comes back as SKILL.md
// text to paste into the library). Lives under the Agent page's transcript; refreshes after each run's `advice` event.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AspireApi, EntryAction, NoteFile, RobotNotes } from "./api";

export interface MemoryEntry {
  topic: string;
  title: string;
  origin: string;
  confidence: number | null;
  useful: string[];
  promoted: boolean;
  held: boolean;
  trigger: string;
  what: string;
  evidence: string;
  limits: string;
}

const TOPICS = ["reach", "locate", "grasp", "place", "containers", "general"] as const;
const HOLD_BELOW = 0.3;              // advice.py HOLD_BELOW: born in a run the judge scored below this and never graded useful since

/** Parse the agent's topic files into entries (the file format is advice.py's; kept in step with it). */
export function parseEntries(files: NoteFile[]): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  const byTopic = new Map(files.filter((f) => f.kind === "topic").map((f) => [f.key, f.body] as const));
  for (const topic of TOPICS) {
    const body = byTopic.get(topic);
    if (!body) continue;
    for (const block of body.split(/^(?=### )/m)) {
      if (!block.startsWith("### ")) continue;
      const lines = block.trimEnd().split("\n");
      const title = lines[0].slice(4).trim();
      const meta: Record<string, string> = {};
      const m = /^<!--\s*(.*?)\s*-->\s*$/.exec(lines[1] ?? "");
      if (m) for (const kv of m[1].split("|")) { const i = kv.indexOf(":"); if (i > 0) meta[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
      const field = (name: string) => {
        const re = new RegExp(`^\\*\\*${name}\\.\\*\\*\\s*(.*)$`);
        for (const ln of lines.slice(1)) { const f = re.exec(ln); if (f) return f[1]; }
        return "";
      };
      const conf = meta.confidence != null && meta.confidence !== "" && Number.isFinite(Number(meta.confidence)) ? Number(meta.confidence) : null;
      const useful = (meta.useful ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.split("@")[0]);
      out.push({
        topic, title, origin: meta.origin ?? "", confidence: conf, useful, promoted: !!meta.promoted,
        held: conf != null && conf < HOLD_BELOW && useful.length === 0,
        trigger: field("Trigger"), what: field("What to do"), evidence: field("Evidence"), limits: field("Limits"),
      });
    }
  }
  return out;
}

/** The context facts: `- **key**: value <!-- run: why -->` lines of CONTEXT.md. */
export function parseContext(files: NoteFile[]): { key: string; value: string; note: string }[] {
  const body = files.find((f) => f.kind === "context")?.body ?? "";
  const out: { key: string; value: string; note: string }[] = [];
  for (const ln of body.split("\n")) {
    const m = /^- \*\*(.+?)\*\*:\s*(.*?)\s*(?:<!--\s*(.*?)\s*-->)?\s*$/.exec(ln);
    if (m) out.push({ key: m[1], value: m[2], note: m[3] ?? "" });
  }
  return out;
}

export const RobotMemory = ({ api, robot, refreshKey }: { api: AspireApi; robot: string; refreshKey: number }) => {
  const [notes, setNotes] = useState<RobotNotes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ title: string; field: "trigger" | "what" | "limits"; text: string } | null>(null);
  const [promotedText, setPromotedText] = useState<{ title: string; text: string } | null>(null);
  const [showLog, setShowLog] = useState(false);

  const load = useCallback(async () => {
    if (!robot) { setNotes(null); return; }
    try { setNotes(await api.notes(robot)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [api, robot]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const entries = useMemo(() => (notes ? parseEntries(notes.files) : []), [notes]);
  const context = useMemo(() => (notes ? parseContext(notes.files) : []), [notes]);
  const changelog = notes?.files.find((f) => f.kind === "changelog")?.body ?? "";
  const promotable = new Set((notes?.promotable ?? []).map((p) => `${p.topic}/${p.title}`));
  const runs = notes?.files.filter((f) => f.kind === "run").length ?? 0;

  const act = async (e: MemoryEntry, body: EntryAction) => {
    setBusy(e.title);
    try {
      const r = await api.entryAction(robot, e.topic, e.title, body);
      if (r.entry_text) setPromotedText({ title: e.title, text: r.entry_text });
      setEditing(null);
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };

  const copy = (text: string) => {
    try { void navigator.clipboard.writeText(text); } catch { /* the textarea below stays selectable */ }
  };

  const summary = !robot ? "pair a robot to see its memory"
    : !notes ? (error ? `unavailable — ${error}` : "loading…")
    : `${entries.length} ${entries.length === 1 ? "entry" : "entries"} · ${context.length} ${context.length === 1 ? "fact" : "facts"} · ${runs} ${runs === 1 ? "run" : "runs"}`
      + (promotable.size ? ` · ${promotable.size} promotable` : "") + (notes.lint.length ? ` · ${notes.lint.length} lint` : "");

  return (
    <div className="rounded-md border border-nori-h14131a/10 bg-nori-hf3f1e8 text-xs text-nori-h5a5346">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between px-3 py-2 text-left" title="What the agent wrote into this robot's memory at the end of earlier runs. It reads this before every task.">
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-nori-hb06a1c">{"// what this robot has learned"}</span>
        <span className="font-mono text-[11px] text-nori-h857b6b">{summary} {open ? "▾" : "▸"}</span>
      </button>
      {open && notes && (
        <div className="max-h-80 space-y-3 overflow-y-auto border-t border-nori-h14131a/10 px-3 py-2">
          {context.length > 0 && (
            <div>
              <div className="font-mono text-[11px] font-semibold text-nori-h14131a">facts about {robot}</div>
              <ul className="mt-1 space-y-0.5">
                {context.map((c) => (
                  <li key={c.key} className="break-words font-mono text-[11px]" title={c.note}>
                    <span className="text-nori-h14131a">{c.key}</span>: {c.value}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {TOPICS.map((topic) => {
            const mine = entries.filter((e) => e.topic === topic);
            if (!mine.length) return null;
            return (
              <div key={topic}>
                <div className="font-mono text-[11px] font-semibold text-nori-h14131a">{topic}</div>
                <ul className="mt-1 space-y-2">
                  {mine.map((e) => {
                    const key = `${e.topic}/${e.title}`;
                    const isEditing = editing?.title === e.title;
                    return (
                      <li key={key} className="rounded border border-nori-h14131a/10 bg-nori-hf6f4eb p-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold text-nori-h14131a">{e.title}</span>
                          <span className="font-mono text-[10px] text-nori-h857b6b" title="the run that wrote it and the judge's confidence on that run">
                            {e.origin}{e.confidence != null ? ` · ${e.confidence.toFixed(2)}` : ""}{e.useful.length ? ` · useful ×${e.useful.length}` : ""}
                          </span>
                          {e.held && <span className="rounded bg-nori-hfdf3e6 px-1 font-mono text-[10px] text-nori-hb06a1c" title="born in a run the judge scored below 0.3: kept, but not shown to the agent until a later run grades it useful">held</span>}
                          {promotable.has(key) && <span className="rounded bg-nori-h8ab135/20 px-1 font-mono text-[10px] text-nori-h4d6a1e" title="graded useful by two runs the judge scored at or above 0.7">promotable</span>}
                          {e.promoted && <span className="rounded bg-nori-h8ab135/20 px-1 font-mono text-[10px] text-nori-h4d6a1e">promoted</span>}
                        </div>
                        {(["trigger", "what", "limits"] as const).map((f) => {
                          const label = f === "trigger" ? "Trigger" : f === "what" ? "What to do" : "Limits";
                          const value = e[f];
                          if (!value && !(isEditing && editing.field === f)) return null;
                          return (
                            <div key={f} className="mt-1 break-words">
                              <span className="font-mono text-[10px] uppercase text-nori-h857b6b">{label} </span>
                              {isEditing && editing.field === f ? (
                                <span className="mt-1 flex gap-1">
                                  <textarea value={editing.text} onChange={(ev) => setEditing({ ...editing, text: ev.target.value })} rows={3}
                                    className="w-full rounded border border-nori-h14131a/20 bg-transparent px-1 py-0.5 text-xs" />
                                  <Button size="sm" variant="outline" disabled={busy === e.title || !editing.text.trim()} onClick={() => void act(e, { action: "edit", field: f, text: editing.text })}>save</Button>
                                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>cancel</Button>
                                </span>
                              ) : (
                                <>
                                  {value}
                                  <button type="button" className="ml-1 font-mono text-[10px] text-nori-h857b6b hover:text-nori-h14131a" title={`edit ${label.toLowerCase()}`}
                                    onClick={() => setEditing({ title: e.title, field: f, text: value })}>edit</button>
                                </>
                              )}
                            </div>
                          );
                        })}
                        {e.evidence && <div className="mt-1 break-words text-nori-h857b6b"><span className="font-mono text-[10px] uppercase">Evidence </span>{e.evidence}</div>}
                        <div className="mt-1.5 flex gap-1">
                          <Button size="sm" variant="outline" disabled={busy === e.title} title="Remove it from what the agent reads; its text goes to the changelog"
                            onClick={() => void act(e, { action: "retract" })}>retract</Button>
                          {!e.promoted && (
                            <Button size="sm" variant="outline" disabled={busy === e.title} title="Mark it promoted and get its text in skill form to paste into the library"
                              onClick={() => void act(e, { action: "promote" })}>promote</Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
          {entries.length === 0 && context.length === 0 && <div className="font-mono text-[11px] text-muted-foreground">Nothing yet: the agent writes here at the end of each run with "learn from this run" on.</div>}
          {promotedText && (
            <div className="rounded border border-nori-h8ab135/40 bg-nori-h8ab135/10 p-2">
              <div className="flex items-center justify-between font-mono text-[11px] font-semibold text-nori-h14131a">
                <span>skill text for "{promotedText.title}" — paste into a SKILL.md</span>
                <span className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => copy(promotedText.text)}>copy</Button>
                  <Button size="sm" variant="ghost" onClick={() => setPromotedText(null)}>close</Button>
                </span>
              </div>
              <textarea readOnly value={promotedText.text} rows={6} className="mt-1 w-full rounded border border-nori-h14131a/20 bg-transparent px-1 py-0.5 font-mono text-[11px]" />
            </div>
          )}
          {notes.lint.length > 0 && (
            <div className="font-mono text-[11px] text-nori-hb06a1c">lint: {notes.lint.join(" · ")}</div>
          )}
          {changelog && (
            <details open={showLog} onToggle={(ev) => setShowLog((ev.target as HTMLDetailsElement).open)}>
              <summary className="cursor-pointer select-none font-mono text-[11px] text-nori-h857b6b">changelog</summary>
              <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded border border-nori-h14131a/10 p-2 font-mono text-[10px] text-nori-h857b6b">{changelog.slice(-6000)}</pre>
            </details>
          )}
          {error && <div className="font-mono text-[11px] text-nori-hb4442e">{error}</div>}
        </div>
      )}
    </div>
  );
};
