// NORI: Additive file. Shared shell for the Nori pages — nav + bootstrap status banner.
// Reuses Tailwind tokens only (no parallel UI kit); shadcn primitives live in
// @/components/ui and can be pulled in per-page as the pages get built out.

import { useEffect } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useNori } from "@/nori/NoriContext";
import { useTeleopSession } from "@/nori/TeleopSessionContext";
import { openDocs } from "@/lib/docs";

// Always-visible connection status. Connecting happens once on Home (ConnectionPanel); every
// page just reads this shared chip. When disconnected it doubles as a shortcut back to Home.
const ConnectionChip = () => {
  const { running, connState, connecting } = useTeleopSession();
  const connected = running && connState === "connected";
  const status = connected
    ? "connected"
    : connecting ? "connecting…" : running ? connState : "not connected";
  const cls =
    "rounded-full px-3 py-1 font-mono text-xs " +
    (connected ? "bg-nori-h8ab135/25 text-nori-h4d6a1e" : "bg-nori-h14131a/8 text-nori-h857b6b");
  return connected ? (
    <span className={cls} title="Connected. Manage the session on Home.">● {status}</span>
  ) : (
    <Link to="/nori" className={cls + " hover:opacity-80"} title="Connect on Home">● {status}</Link>
  );
};

const NAV: { to: string; label: string }[] = [
  { to: "/nori/remote", label: "Remote" },
  { to: "/nori/coding", label: "Coding" },
  { to: "/nori/agent", label: "Agent" },
  { to: "/nori/training", label: "Training" },
  { to: "/nori/my-stuff", label: "My Stuff" },
  { to: "/nori/marketplace", label: "Marketplace" },
  { to: "/nori/pairing", label: "Pairing" },
  { to: "/nori/account", label: "Account" },
];

const NoriLayout = () => {
  const { loading, error, ready, session } = useNori();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  // Landing (/nori) and marketplace bring themselves up with their own staggered FadeIn, so the
  // blanket page fade would double up there — everywhere else gets the quick full-page fade.
  const pageFade = pathname !== "/nori" && pathname !== "/nori/marketplace";

  // Once bootstrap is done and Supabase is ready, an unauthenticated visitor to any
  // Nori page is sent to sign-in. We wait for `!loading` so we don't bounce during the
  // initial session restore.
  useEffect(() => {
    if (!loading && ready && !session) {
      navigate("/nori/sign-in", { replace: true });
    }
  }, [loading, ready, session, navigate]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <nav className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">
          <Link to="/nori" className="flex items-center gap-2 font-semibold">
            <img src="/nori-logo.png" alt="Nori" className="h-7 w-7" />
            Nori
          </Link>
          <div className="flex gap-6 text-sm">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={
                  pathname === item.to
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }
              >
                {item.label}
              </Link>
            ))}
            {/* Docs live on a separately-hosted site, never bundled into the desktop build —
                so this is a link OUT, not a route. openDocs() sends it to the system browser
                on desktop (a plain <a> would navigate the app's own webview away from itself). */}
            <button
              type="button"
              onClick={() => void openDocs()}
              className="text-muted-foreground hover:text-foreground"
              title="Open the Nori docs in your browser"
            >
              Docs ↗
            </button>
          </div>
          <div className="ml-auto">
            <ConnectionChip />
          </div>
        </nav>
      </header>

      {loading && (
        <div className="bg-muted px-4 py-2 text-center text-sm text-muted-foreground">
          Connecting to Nori…
        </div>
      )}
      {error && (
        <div className="bg-destructive/10 px-4 py-2 text-center text-sm text-destructive">
          {error}
        </div>
      )}

      <main className="mx-auto max-w-5xl px-4 py-6">
        {/* Quick 0.7s page fade on every navigation, keyed by path so it re-plays. Skipped on
            landing + marketplace, which already run their own staggered FadeIn bring-up. The
            motion-reduce guard drops the animation for users who ask for reduced motion. */}
        {pageFade ? (
          <div key={pathname} className="animate-in fade-in duration-700 motion-reduce:animate-none">
            <Outlet />
          </div>
        ) : (
          <Outlet />
        )}
      </main>
    </div>
  );
};

export default NoriLayout;
