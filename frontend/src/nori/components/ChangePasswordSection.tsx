// NORI: Change-password panel for the signed-in account page. Re-authenticates
// with the CURRENT password before setting the new one — so a left-open or
// hijacked session can't silently change the password and lock the owner out.
import { useState } from "react";
import Panel from "@/nori/components/Panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signInWithPassword, updatePassword } from "@/nori/auth/session";

const MIN_LEN = 8; // our minimum; Supabase enforces its own project minimum too.

export default function ChangePasswordSection({ email }: { email: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (next.length < MIN_LEN) {
      setError(`New password must be at least ${MIN_LEN} characters.`);
      return;
    }
    if (next !== confirm) {
      setError("New passwords don't match.");
      return;
    }
    if (next === current) {
      setError("New password must be different from the current one.");
      return;
    }
    setBusy(true);
    try {
      // Re-auth: verifies the current password (a wrong one throws here) and
      // refreshes the session before the change.
      await signInWithPassword(email, current);
      await updatePassword(next);
      setDone(true);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(
        /invalid login credentials/i.test(msg)
          ? "Current password is incorrect."
          : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel eyebrow="security" title="Change password" bodyClassName="space-y-3">
      <form onSubmit={submit} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="cp-current">Current password</Label>
          <Input
            id="cp-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cp-new">New password</Label>
          <Input
            id="cp-new"
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
          <Label htmlFor="cp-confirm">Confirm new password</Label>
          <Input
            id="cp-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {done && <p className="text-sm font-medium text-nori-h8ab135">Password updated.</p>}
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Updating…" : "Update password"}
        </Button>
      </form>
    </Panel>
  );
}
