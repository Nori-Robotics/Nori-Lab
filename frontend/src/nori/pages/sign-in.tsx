// NORI: Additive file. Sign-in screen stub (Phase 2).
// Phase 2 builds: email/password form via Supabase JS SDK -> on success store JWT
// (SDK handles it) and redirect to /nori/account, then call provision_customer().

import { useNori } from "@/nori/NoriContext";

const SignIn = () => {
  const { ready, loading, error } = useNori();
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-bold">Nori — Sign in</h1>
        <p className="text-muted-foreground text-sm">
          {loading
            ? "Connecting to Nori…"
            : error
              ? error
              : ready
                ? "Auth wired. Sign-in form lands in Phase 2."
                : "Nori auth not configured."}
        </p>
      </div>
    </div>
  );
};

export default SignIn;
