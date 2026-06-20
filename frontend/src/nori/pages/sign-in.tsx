// NORI: Additive file. Sign-in screen (Phase 2).
// Email/password via the Supabase JS SDK. On success the SDK stores + auto-refreshes the
// JWT; NoriProvider observes the new session and provisions the customer. We then route
// to /nori/account.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useNori } from "@/nori/NoriContext";
import { signInWithPassword } from "@/nori/auth/session";

const SignIn = () => {
  const { ready, loading, error, session } = useNori();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Already signed in (or just signed in) → go to the account page.
  useEffect(() => {
    if (session) navigate("/nori/account", { replace: true });
  }, [session, navigate]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await signInWithPassword(email, password);
      // navigation happens via the session effect above
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to Nori</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Connecting to Nori…</p>
          ) : !ready ? (
            <p className="text-sm text-destructive">{error ?? "Nori auth not configured."}</p>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {formError && <p className="text-sm text-destructive">{formError}</p>}
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default SignIn;
