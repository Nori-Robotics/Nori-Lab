// NORI: Forgot-password request screen (standalone, no auth gate). Sends a Supabase
// password-reset email. NON-ENUMERATING: on success we always show the same "if an
// account exists" message — Supabase itself returns success regardless of whether
// the address has an account, so we never reveal account existence.
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell } from "@/nori/components/AuthShell";
import { useNori } from "@/nori/NoriContext";
import { sendPasswordReset } from "@/nori/auth/session";

const ForgotPassword = () => {
  const { ready, loading, error } = useNori();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await sendPasswordReset(email);
      setSent(true);
    } catch (err) {
      // Rate-limit / transport errors — safe to surface (they don't reveal whether
      // the account exists).
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      eyebrow="no trouble"
      title="Reset your password"
      subtitle="Happens to everyone. We'll email you a link to set a new one."
      footer={
        <Link
          to="/nori/sign-in"
          className="font-medium text-foreground underline underline-offset-4"
        >
          Back to sign in
        </Link>
      }
    >
      {loading ? (
        <p className="text-sm text-muted-foreground">Connecting to Nori…</p>
      ) : !ready ? (
        <p className="text-sm text-destructive">{error ?? "Nori auth not configured."}</p>
      ) : sent ? (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            If an account exists for <span className="font-medium text-foreground">{email}</span>,
            we&apos;ve sent a password-reset link. Check your inbox (and spam).
          </p>
        </div>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted-foreground">
            Enter your account email and we&apos;ll send you a link to set a new password.
          </p>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="fp-email">Email</Label>
              <Input
                id="fp-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            {formError && <p className="text-sm text-destructive">{formError}</p>}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Sending…" : "Send reset link"}
            </Button>
          </form>
        </>
      )}
    </AuthShell>
  );
};

export default ForgotPassword;
