// NORI: Additive file. Sign-in / sign-up screen (Phase 2).
// Email/password via the Supabase JS SDK. On success (or on sign-up when email
// confirmation is disabled) the SDK stores + auto-refreshes the JWT; NoriProvider
// observes the new session and provisions the customer. We then route to /nori/account.
// Registration is handled entirely by Supabase Auth — the backend has no signup
// endpoint by design; it provisions the customer row (POST /customers/me/provision)
// once a valid JWT exists.

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell } from "@/nori/components/AuthShell";
import { useNori } from "@/nori/NoriContext";
import { resendConfirmation, signInWithPassword, signUp } from "@/nori/auth/session";

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
  // Set when a signup needs email confirmation, or a sign-in fails because the
  // email isn't confirmed yet — enables the "resend confirmation" action.
  const [pendingConfirmEmail, setPendingConfirmEmail] = useState<string | null>(null);
  const [resending, setResending] = useState(false);

  // Already signed in (or just signed in) → go to the landing page.
  useEffect(() => {
    if (session) navigate("/nori", { replace: true });
  }, [session, navigate]);

  const switchMode = (next: Mode) => {
    setMode(next);
    setFormError(null);
    setNotice(null);
    setPendingConfirmEmail(null);
  };

  const onResend = async () => {
    if (!pendingConfirmEmail) return;
    setResending(true);
    setFormError(null);
    try {
      await resendConfirmation(pendingConfirmEmail);
      // Non-enumerating: don't reveal whether the address is registered/unconfirmed.
      setNotice(
        `If ${pendingConfirmEmail} still needs confirming, we've sent a new link. Check your inbox.`
      );
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setResending(false);
    }
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
          setNotice("Account created. Check your email for a confirmation link, then sign in.");
          setPendingConfirmEmail(email);
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
      const msg = err instanceof Error ? err.message : String(err);
      setFormError(msg);
      // Strict email verification: Supabase rejects sign-in until confirmed.
      // Surface the resend action so the user can recover.
      if (/not confirmed|confirm your email/i.test(msg)) {
        setPendingConfirmEmail(email);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const isSignup = mode === "signup";

  return (
    <AuthShell
      eyebrow={isSignup ? "welcome to Nori Lab" : "glad you made it"}
      title={isSignup ? "Let's get you set up" : "Welcome back"}
      subtitle={
        isSignup
          ? "Make an account to pair and manage your robot, record datasets and train."
          : "Sign in to reach your robots, datasets and training."
      }
      footer={
        <>
          {isSignup ? "Already have an account?" : "Need an account?"}{" "}
          <button
            type="button"
            className="font-medium text-foreground underline underline-offset-4"
            onClick={() => switchMode(isSignup ? "signin" : "signup")}
          >
            {isSignup ? "Sign in" : "Create one"}
          </button>
        </>
      }
    >
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
              {!isSignup && (
                <div className="text-right">
                  <Link
                    to="/nori/forgot-password"
                    className="text-xs font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
                  >
                    Forgot password?
                  </Link>
                </div>
              )}
            </div>
            {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
            {formError && <p className="text-sm text-destructive">{formError}</p>}
            {pendingConfirmEmail && !isSignup && (
              <button
                type="button"
                onClick={onResend}
                disabled={resending}
                className="text-sm font-medium text-foreground underline underline-offset-4 disabled:opacity-60"
              >
                {resending ? "Sending…" : "Resend confirmation email"}
              </button>
            )}
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
        </>
      )}
    </AuthShell>
  );
};

export default SignIn;
