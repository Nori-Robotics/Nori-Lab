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
    <div className="mt-4 space-y-3 border-t border-border pt-4">
      <div className="space-y-1.5">
        <Label htmlFor="room">Room (NORI_ROOM — must match the Pi)</Label>
        <Input id="room" value={settings.room} onChange={(e) => set("room", e.target.value)}
          placeholder={serial || "nori-dev"} />
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
        <Label htmlFor="token">Room token (your Nori serial number)</Label>
        <Input id="token" type="password" value={settings.token}
          onChange={(e) => set("token", e.target.value)}
          placeholder={serial || "your Nori serial number"} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="stun">STUN</Label>
        <Input id="stun" value={settings.stun} onChange={(e) => set("stun", e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="turn">TURN URL(s) (blank = STUN-only)</Label>
        <Input id="turn" value={settings.turn} onChange={(e) => set("turn", e.target.value)}
          placeholder="turn:turn.example.com:3478?transport=udp" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="turnUser">TURN user</Label>
          <Input id="turnUser" value={settings.turnUser}
            onChange={(e) => set("turnUser", e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="turnCred">TURN cred</Label>
          <Input id="turnCred" type="password" value={settings.turnCred}
            onChange={(e) => set("turnCred", e.target.value)} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={settings.forceRelay}
          onCheckedChange={(c) => set("forceRelay", c === true)}
        />
        force relay (TURN-only — Step 6 test)
      </label>
      <p className="text-xs text-muted-foreground">
        Settings persist locally and must match the Pi's <span className="font-mono">.env</span>.
        Change while connected to apply on the next session (Disconnect → Connect).
      </p>
    </div>
  );
}
