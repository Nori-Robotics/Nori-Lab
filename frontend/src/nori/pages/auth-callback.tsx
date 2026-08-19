// NORI: Additive file. Email-confirmation landing (standalone, no auth gate).
// The Supabase signup-confirmation email links here; the SDK turns the URL token
// into a session (detectSessionInUrl), which may land before or after mount — so
// we check getSession now AND subscribe to the auth event, mirroring the
// reset-password page. On success the customer is confirmed + signed in, and
// NoriProvider provisions the customer once it observes the session, so we route
// to /nori/account. No session after checking = an invalid/expired link.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useNori } from "@/nori/NoriContext";
import { getSession, onAuthStateChange } from "@/nori/auth/session";

const AuthCallback = () => {
  const { ready, loading, error } = useNori();
  const navigate = useNavigate();
  const [confirmed, setConfirmed] = useState(false);
  const [checked, setChecked] = useState(false); // finished looking for a session

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void (async () => {
      const s = await getSession();
      if (cancelled) return;
      if (s) setConfirmed(true);
      setChecked(true);
    })();
    const unsub = onAuthStateChange((s) => {
      if (s) setConfirmed(true);
      setChecked(true);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [ready]);

  // Once a session exists, hand off to the app (NoriProvider provisions).
  useEffect(() => {
    if (!confirmed) return;
    const t = setTimeout(() => navigate("/nori/account", { replace: true }), 1200);
    return () => clearTimeout(t);
  }, [confirmed, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Confirming your email</CardTitle>
        </CardHeader>
        <CardContent>
          {loading || !checked ? (
            <p className="text-sm text-muted-foreground">Confirming your email…</p>
          ) : !ready ? (
            <p className="text-sm text-destructive">{error ?? "Nori auth not configured."}</p>
          ) : confirmed ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-nori-h8ab135">Email confirmed.</p>
              <p className="text-sm text-muted-foreground">Taking you to your account…</p>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-destructive">
                This confirmation link is invalid or has expired.
              </p>
              <Link
                to="/nori/sign-in"
                className="inline-block text-sm font-medium text-foreground underline underline-offset-4"
              >
                Go to sign in
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default AuthCallback;
