// NORI: Additive. The ONE place to connect the teleop session and edit session settings.
//
// The RemoteTeleop session lives in TeleopSessionContext and outlives page navigation, so there
// only needs to be a single connect surface for the whole app. It's embedded in the landing
// page's robot card: press Connect once and every page (Remote / Coding / Agent) drives the same
// already-open session. Other pages just read the shared status chip in the header.
//
// Split into two bare pieces so the robot card can lay them out around the robot image:
//   ConnectionControls — compact row (Connect/Disconnect · status · settings toggle), sits in the
//                        text column so the image can span the full card height beside it.
//   ConnectionSettings — the collapsible settings form, rendered full-width below the card row.
// `showSettings` is owned by the parent (Home) so it can place the two pieces independently.

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useNori } from "@/nori/NoriContext";
import { useTeleopSession } from "@/nori/TeleopSessionContext";
import { ConnectionBanner } from "@/nori/remote/TeleopStatus";

/**
 * The connect-failure banner, on the page that owns the settings it tells you to fix.
 *
 * Remote renders the same banner, but a failed connect is usually a settings problem (wrong
 * access code, wrong room), and the settings only exist here — so Remote passes `settingsTo`
 * and its banner links back to this page; here the settings sit directly below the banner and
 * no link is needed. Renders nothing while idle or connected, so it costs no space in the
 * common case.
 */
export function ConnectionStatus() {
  const { connectStatus } = useTeleopSession();
  return <ConnectionBanner status={connectStatus} />;
}

export function ConnectionControls({
  showSettings, onToggleSettings,
}: { showSettings: boolean; onToggleSettings: () => void }) {
  const { ready } = useNori();
  const { connState, connecting, running, connect, disconnect } = useTeleopSession();

  const connected = running && connState === "connected";
  const status = connected
    ? "connected"
    : connecting ? "connecting…" : running ? `conn: ${connState}` : "not connected";

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      {!running ? (
        <Button size="sm" variant="secondary" onClick={connect} disabled={connecting || !ready}>
          {connecting ? "Connecting…" : "Connect"}
        </Button>
      ) : (
        <Button size="sm" variant="destructive" onClick={disconnect}>Disconnect</Button>
      )}
      <span
        className={
          "rounded-full px-3 py-1 font-mono text-xs " +
          (connected ? "bg-[#8ab135]/25 text-[#4d6a1e]" : "bg-[#14131a]/8 text-[#857b6b]")
        }
      >
        ● {status}
      </span>
      <button
        type="button"
        onClick={onToggleSettings}
        className="eyebrow ml-auto text-ink hover:underline"
      >
        {showSettings ? "hide settings ▲" : "session settings ▼"}
      </button>
    </div>
  );
}

export function ConnectionSettings() {
  const { customer, activeRobotSerial } = useNori();
  const { settings, setSetting: set } = useTeleopSession();
  const serial = activeRobotSerial ?? customer?.robot_serial_number ?? "";

  return (
    <div className="mt-4 space-y-3 border-t border-[#14131a]/10 pt-4">
      <div className="space-y-1.5">
        <Label htmlFor="room">Room (your Nori serial number)</Label>
        {/* The room IS the Supabase realtime channel name — matched EXACTLY against the Pi's
            NORI_ROOM. Forced to UPPERCASE on every keystroke. NOTE: this breaks lowercase dev
            rooms (e.g. NORI_ROOM=nori-dev -> NORI-DEV joins a channel the robot isn't on); set the
            robot's NORI_ROOM to uppercase to match, or use a real (uppercase) serial. */}
        <Input id="room" value={settings.room}
          onChange={(e) => set("room", e.target.value.toUpperCase())}
          autoCorrect="off"
          spellCheck={false}
          placeholder={serial || "NORI-DEV"} />
        {serial ? (
          settings.room === serial ? (
            <p className="text-xs text-muted-foreground">
              using paired robot <span className="font-mono">{serial}</span>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              paired robot: <span className="font-mono">{serial}</span>{" "}
              <button type="button" className="underline hover:text-foreground"
                onClick={() => set("room", serial)}>use it</button>
            </p>
          )
        ) : (
          <p className="text-xs text-muted-foreground">
            pair a robot (Pairing) to auto-fill this from its serial.
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="token">Room token (your special password)</Label>
        <Input id="token" type="password" value={settings.token}
          onChange={(e) => set("token", e.target.value)}
          placeholder="your special password" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="stun">STUN</Label>
        <Input id="stun" value={settings.stun} onChange={(e) => set("stun", e.target.value)} />
      </div>
      {/* TURN URL/user/cred inputs intentionally removed (§2.4 minted creds). The backend now
          mints per-session coturn credentials at connect and TeleopSessionContext overrides
          turnUrls/turnUser/turnCred with them; the relay is on use-auth-secret, so a hand-typed
          STATIC cred would be REJECTED — the field could only make a working session fail. The
          Settings fields + connect() fallback are kept (a dev can still inject via localStorage);
          full retirement lands with Surface 3 (robot per-session fetch). */}
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={settings.forceRelay}
          onCheckedChange={(c) => set("forceRelay", c === true)}
        />
        force relay (TURN-only)
      </label>
      <p className="text-xs text-muted-foreground">
        Settings persist, disconnect then reconnect to see changes.
      </p>
    </div>
  );
}
