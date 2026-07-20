// NORI: Additive. The "Are you still there?" prompt that precedes an idle auto-disconnect.
//
// Rendered once, by TeleopSessionProvider, so it's app-wide: the session outlives navigation, so
// the prompt has to as well (you can go idle on Coding and get asked there, not just on Home).
//
// Deliberately NOT dismissible by clicking outside or pressing Escape. The whole premise is that
// nobody is at the keyboard, so a dialog that a stray click could dismiss would silently cancel
// the disconnect and leave the session open — the exact failure being fixed. The only two exits
// are the explicit buttons and the countdown.
//
// Outside-click is already handled for us: Radix's AlertDialog (unlike Dialog) is modal and has no
// outside-dismiss, which is exactly why it's the right primitive here — it doesn't even accept
// onPointerDownOutside. Escape is the one dismissal it does allow, so that's the one we block.

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export default function IdleDisconnectDialog({
  open, secondsLeft, onConfirm, onDisconnect,
}: {
  open: boolean;
  secondsLeft: number;
  onConfirm: () => void;
  onDisconnect: () => void;
}) {
  return (
    <AlertDialog open={open}>
      <AlertDialogContent onEscapeKeyDown={(e) => e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you still there?</AlertDialogTitle>
          <AlertDialogDescription>
            Your robot has been connected with no activity for 5 minutes. To keep it free for
            others (and stop it holding position), we'll disconnect in{" "}
            <span className="font-mono font-semibold tabular-nums">{secondsLeft}s</span>.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* Cancel = "disconnect now": the destructive-but-expected outcome, so it's the
              secondary slot. Action = "stay connected", the affirmative answer to the title. */}
          <AlertDialogCancel onClick={onDisconnect}>Disconnect now</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} autoFocus>
            Yes, I'm still here
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
