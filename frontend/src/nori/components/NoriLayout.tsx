// NORI: Additive file. Shared shell for the Nori pages — nav + bootstrap status banner.
// Reuses Tailwind tokens only (no parallel UI kit); shadcn primitives live in
// @/components/ui and can be pulled in per-page as the pages get built out.

import { useEffect } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useNori } from "@/nori/NoriContext";

const NAV: { to: string; label: string }[] = [
  { to: "/nori/account", label: "Account" },
  { to: "/nori/marketplace", label: "Marketplace" },
  { to: "/nori/training-history", label: "Training" },
  { to: "/nori/consents", label: "Consents" },
  { to: "/nori/pairing", label: "Pairing" },
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
          <Link to="/nori/account" className="font-semibold">
            Nori
          </Link>
          <div className="flex gap-3 text-sm">
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
          <Link to="/" className="ml-auto text-sm text-muted-foreground hover:text-foreground">
            ← LeLab
          </Link>
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
