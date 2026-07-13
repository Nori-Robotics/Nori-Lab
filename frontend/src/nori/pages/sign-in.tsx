// NORI: Additive file. Sign-in / sign-up screen (Phase 2).
// Email/password via the Supabase JS SDK. On success (or on sign-up when email
// confirmation is disabled) the SDK stores + auto-refreshes the JWT; NoriProvider
// observes the new session and provisions the customer. We then route to /nori/account.
// Registration is handled entirely by Supabase Auth — the backend has no signup
// endpoint by design; it provisions the customer row (POST /customers/me/provision)
// once a valid JWT exists.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useNori } from "@/nori/NoriContext";
import { signInWithPassword, signUp } from "@/nori/auth/session";

type Mode = "signin" | "signup";

const SignIn = () => {
  const { ready, loading, error, session } = useNori();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Already signed in (or just signed in) → go to the landing page.
  useEffect(() => {
    if (session) navigate("/nori", { replace: true });
  }, [session, navigate]);

  const switchMode = (next: Mode) => {
    setMode(next);
    setFormError(null);
    setNotice(null);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      if (mode === "signup") {
        const { needsEmailConfirmation } = await signUp(email, password);
        if (needsEmailConfirmation) {
          // No session yet — the user must confirm via email before signing in.
          setNotice("Account created. Check your email to confirm, then sign in.");
          setMode("signin");
          setPassword("");
        }
        // Otherwise a session was returned; the session effect above navigates and
        // NoriProvider provisions the customer automatically.
      } else {
        await signInWithPassword(email, password);
        // navigation happens via the session effect above
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const isSignup = mode === "signup";

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{isSignup ? "Create your Nori account" : "Sign in to Nori"}</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Connecting to Nori…</p>
          ) : !ready ? (
            <p className="text-sm text-destructive">{error ?? "Nori auth not configured."}</p>
          ) : (
            <>
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
                    autoComplete={isSignup ? "new-password" : "current-password"}
                    minLength={isSignup ? 6 : undefined}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                  {isSignup && (
                    <p className="text-xs text-muted-foreground">At least 6 characters.</p>
                  )}
                </div>
                {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
                {formError && <p className="text-sm text-destructive">{formError}</p>}
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting
                    ? isSignup
                      ? "Creating account…"
                      : "Signing in…"
                    : isSignup
                      ? "Create account"
                      : "Sign in"}
                </Button>
              </form>
              <p className="mt-4 text-center text-sm text-muted-foreground">
                {isSignup ? "Already have an account?" : "Need an account?"}{" "}
                <button
                  type="button"
                  className="font-medium text-foreground underline underline-offset-4"
                  onClick={() => switchMode(isSignup ? "signin" : "signup")}
                >
                  {isSignup ? "Sign in" : "Create one"}
                </button>
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default SignIn;
