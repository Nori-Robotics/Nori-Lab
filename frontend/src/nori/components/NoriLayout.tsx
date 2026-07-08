// NORI: Additive file. Shared shell for the Nori pages — nav + bootstrap status banner.
// Reuses Tailwind tokens only (no parallel UI kit); shadcn primitives live in
// @/components/ui and can be pulled in per-page as the pages get built out.

import { useEffect } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useNori } from "@/nori/NoriContext";

const NAV: { to: string; label: string }[] = [
  { to: "/nori/remote", label: "Remote" },
  { to: "/nori/coding", label: "Coding" },
  { to: "/nori/training", label: "Training" },
  { to: "/nori/marketplace", label: "Marketplace" },
  { to: "/nori/pairing", label: "Pairing" },
  { to: "/nori/account", label: "Account" },
];

const NoriLayout = () => {
  const { loading, error, ready, session } = useNori();
  const { pathname } = useLocation();
  const navigate = useNavigate();

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
        <Outlet />
      </main>
    </div>
  );
};

export default NoriLayout;
