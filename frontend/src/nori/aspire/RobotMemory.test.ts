import { describe, expect, it } from "vitest";
import { parseContext, parseEntries } from "@/nori/aspire/RobotMemory";
import type { NoteFile } from "@/nori/aspire/api";

const files: NoteFile[] = [
  { kind: "context", key: "", version: 2, body: "# r: context\n\nintro\n- **table_z**: 0.745 m <!-- t2: measured -->\n- **right inward y**: -0.04 <!-- t1: stall -->" },
  { kind: "topic", key: "reach", version: 3, body: "# r: reach\n\nintro\n\n### Right arm inward edge\n<!-- origin: t1 | confidence: 0.8 | useful: t2@0.9,t3@0.75 -->\n**Trigger.** target y > -0.05\n**What to do.** use the left arm\n**Evidence.** stalled at -0.04\n**Limits.** (t4) not at lift 0.3\n\n### Weak one\n<!-- origin: t5 | confidence: 0.1 -->\n**Trigger.** t\n**What to do.** w\n" },
  { kind: "topic", key: "grasp", version: 1, body: "# r: grasp\n\n### Promoted one\n<!-- origin: t1 | confidence: 0.9 | promoted: lab:me -->\n**Trigger.** t\n**What to do.** w\n" },
];

describe("RobotMemory parsing", () => {
  it("reads entries by topic with their meta, fields, held and promoted state", () => {
    const es = parseEntries(files);
    expect(es.map((e) => [e.topic, e.title])).toEqual([["reach", "Right arm inward edge"], ["reach", "Weak one"], ["grasp", "Promoted one"]]);
    expect(es[0]).toMatchObject({ origin: "t1", confidence: 0.8, useful: ["t2", "t3"], held: false, promoted: false, trigger: "target y > -0.05", what: "use the left arm", evidence: "stalled at -0.04", limits: "(t4) not at lift 0.3" });
    expect(es[1]).toMatchObject({ held: true, confidence: 0.1 });
    expect(es[2]).toMatchObject({ promoted: true, held: false });
  });

  it("reads the context facts", () => {
    expect(parseContext(files)).toEqual([{ key: "table_z", value: "0.745 m", note: "t2: measured" }, { key: "right inward y", value: "-0.04", note: "t1: stall" }]);
  });
});
