// NORI: Reset-password landing (standalone, no auth gate). The Supabase reset email
// links here with a recovery token; the SDK turns it into a short-lived recovery
// session (a PASSWORD_RECOVERY auth event). We detect that session, let the user set
// a new password (updateUser), then sign out so they re-authenticate with the new
// one. An arrival with no recovery session = an invalid/expired link.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useNori } from "@/nori/NoriContext";
import { getSession, onAuthStateChange, signOut, updatePassword } from "@/nori/auth/session";

const MIN_LEN = 8;

const ResetPassword = () => {
  const { ready, loading, error } = useNori();
  const [canReset, setCanReset] = useState(false);
  const [checked, setChecked] = useState(false); // finished looking for a recovery session
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // The recovery session is established when the SDK processes the URL token, which
  // may land before or after mount — cover both: check getSession now AND subscribe
  // to the auth event.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void (async () => {
      const s = await getSession();
      if (cancelled) return;
      if (s) setCanReset(true);
      setChecked(true);
    })();
    const unsub = onAuthStateChange((s) => {
      if (s) setCanReset(true);
      setChecked(true);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [ready]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (next.length < MIN_LEN) {
      setFormError(`Password must be at least ${MIN_LEN} characters.`);
      return;
    }
    if (next !== confirm) {
      setFormError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await updatePassword(next);
      // Clear the recovery session; require a fresh sign-in with the new password.
      await signOut();
      setDone(true);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Set a new password</CardTitle>
        </CardHeader>
        <CardContent>
          {loading || !checked ? (
            <p className="text-sm text-muted-foreground">Connecting to Nori…</p>
          ) : !ready ? (
            <p className="text-sm text-destructive">{error ?? "Nori auth not configured."}</p>
          ) : done ? (
            <div className="space-y-4">
              <p className="text-sm font-medium text-nori-h8ab135">Password updated.</p>
              <p className="text-sm text-muted-foreground">Sign in with your new password.</p>
              <Link
                to="/nori/sign-in"
                className="inline-block text-sm font-medium text-foreground underline underline-offset-4"
              >
                Go to sign in
              </Link>
            </div>
          ) : !canReset ? (
            <div className="space-y-4">
              <p className="text-sm text-destructive">
                This reset link is invalid or has expired.
              </p>
              <Link
                to="/nori/forgot-password"
                className="inline-block text-sm font-medium text-foreground underline underline-offset-4"
              >
                Request a new link
              </Link>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="rp-new">New password</Label>
                <Input
                  id="rp-new"
                  type="password"
                  autoComplete="new-password"
                  minLength={MIN_LEN}
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  required
                />
                <p className="text-xs text-muted-foreground">At least {MIN_LEN} characters.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rp-confirm">Confirm new password</Label>
                <Input
                  id="rp-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
              </div>
              {formError && <p className="text-sm text-destructive">{formError}</p>}
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Updating…" : "Update password"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default ResetPassword;
