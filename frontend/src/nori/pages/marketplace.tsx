// NORI: Additive file. Marketplace browse + install (Phase 3).
// Lists policies (GET /nori/marketplace/policies), filters by source client-side, and
// installs = acquire (first-party) + download bytes to the local Nori cache. Running a
// downloaded policy against the robot (rollout) is blocked on the Pi.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "@/contexts/ApiContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  acquirePolicy,
  downloadPolicy,
  listPolicies,
  type PolicyListEntry,
} from "@/nori/api/client";

type SourceFilter = "all" | "own" | "first_party" | "community";
const SOURCES: { key: SourceFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "own", label: "Own" },
  { key: "first_party", label: "First-party" },
  { key: "community", label: "Community" },
];

type InstallState = { status: "idle" | "working" | "done" | "error"; message?: string };

const sourceBadge = (source: string) => {
  const map: Record<string, string> = {
    own: "bg-blue-500/15 text-blue-700",
    first_party: "bg-green-500/15 text-green-700",
    community: "bg-purple-500/15 text-purple-700",
  };
  return map[source] ?? "bg-muted/15 text-muted-foreground";
};

const PolicyCard = ({
  policy,
  state,
  onInstall,
}: {
  policy: PolicyListEntry;
  state: InstallState;
  onInstall: () => void;
}) => (
  <Card>
    <CardHeader>
      <div className="flex items-start justify-between gap-2">
        <CardTitle className="text-base">{policy.title}</CardTitle>
        <span className={`rounded px-2 py-0.5 text-xs ${sourceBadge(policy.source)}`}>
          {policy.source}
        </span>
      </div>
    </CardHeader>
    <CardContent className="space-y-3">
      {policy.description && (
        <p className="text-sm text-muted-foreground line-clamp-3">{policy.description}</p>
      )}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {policy.policy_class && <span>{policy.policy_class}</span>}
        {policy.price_usd != null && <span>· ${policy.price_usd}</span>}
      </div>
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" onClick={onInstall} disabled={state.status === "working"}>
          {state.status === "working"
            ? "Installing…"
            : state.status === "done"
              ? "Reinstall"
              : "Install"}
        </Button>
        {state.message && (
          <span
            className={`text-xs ${state.status === "error" ? "text-destructive" : "text-muted-foreground"}`}
          >
            {state.message}
          </span>
        )}
      </div>
    </CardContent>
  </Card>
);

const Marketplace = () => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [policies, setPolicies] = useState<PolicyListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<SourceFilter>("all");
  const [query, setQuery] = useState("");
  const [installs, setInstalls] = useState<Record<string, InstallState>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await listPolicies(baseUrl, fetchWithHeaders);
        if (!cancelled) setPolicies(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchWithHeaders]);

  const install = useCallback(
    async (policy: PolicyListEntry) => {
      setInstalls((s) => ({ ...s, [policy.ref]: { status: "working" } }));
      try {
        // First-party listings need an acquire step before download; own-trained don't.
        if (policy.source === "first_party") {
          await acquirePolicy(baseUrl, fetchWithHeaders, policy.ref);
        }
        const res = await downloadPolicy(baseUrl, fetchWithHeaders, policy.ref);
        const kb = Math.max(1, Math.round(res.size_bytes / 1024));
        setInstalls((s) => ({
          ...s,
          [policy.ref]: { status: "done", message: `Cached ${kb} KB locally` },
        }));
      } catch (e) {
        setInstalls((s) => ({
          ...s,
          [policy.ref]: {
            status: "error",
            message: e instanceof Error ? e.message : String(e),
          },
        }));
      }
    },
    [baseUrl, fetchWithHeaders]
  );

  const filtered = useMemo(() => {
    if (!policies) return [];
    const q = query.trim().toLowerCase();
    return policies.filter((p) => {
      if (source !== "all" && p.source !== source) return false;
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [policies, source, query]);

  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-bold">Marketplace</h1>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {SOURCES.map((s) => (
            <Button
              key={s.key}
              size="sm"
              variant={source === s.key ? "default" : "outline"}
              onClick={() => setSource(s.key)}
            >
              {s.label}
            </Button>
          ))}
        </div>
        <Input
          placeholder="Search policies…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-xs"
        />
      </div>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : policies === null ? (
        <p className="text-sm text-muted-foreground">Loading marketplace…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No policies match.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <PolicyCard
              key={p.ref}
              policy={p}
              state={installs[p.ref] ?? { status: "idle" }}
              onInstall={() => install(p)}
            />
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Installed policies are cached locally. Running one on the robot is available once
        robot connectivity ships.
      </p>
    </section>
  );
};

export default Marketplace;
