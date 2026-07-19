// NORI: Additive file. Phase 7 feature gates.
//
// M6 = full telepresence video (operator camera -> robot screen). Per the plan it is
// BUILT but shipped DARK: all the capture/self-view/track-attach code exists and is
// exercisable, but the UI is hidden and the camera is never acquired unless this flag is on.
// Flip it for local dev without a rebuild via the browser console:
//   localStorage.setItem("nori_m6_video", "1"); location.reload();
//
// Keep this the single place the app asks "is operator video on?" so turning M6 on later is
// a one-line change (or a build-time default), not a hunt through the call code.

export function isM6VideoEnabled(): boolean {
  try {
    return localStorage.getItem("nori_m6_video") === "1";
  } catch {
    return false;
  }
}

// TURN credential minting (rpi5_production_readiness §2.4 / signaling Phase 3): fetch
// short-lived coturn credentials at session start instead of using the static typed/
// persisted creds. Shipped DARK until the coturn relay is flipped to `use-auth-secret`
// AND the backend NORI_TURN_STATIC_AUTH_SECRET is provisioned — until then a minted
// credential would be rejected by a relay still on `lt-cred-mech`. The cutover is:
// flip the relay + set the backend secret + enable this flag. Flip for dev/cutover via:
//   localStorage.setItem("nori_turn_mint", "1"); location.reload();
export function isTurnMintEnabled(): boolean {
  try {
    return localStorage.getItem("nori_turn_mint") === "1";
  } catch {
    return false;
  }
}

// Private signaling rooms (signaling Phase 1 / 1e): join realtime:<serial> as a PRIVATE
// channel so Supabase RLS admits only the robot + its paired customer. Now DEFAULT ON —
// every connection is private unless explicitly opted out. This is safe for un-migrated
// (public) robots because the SDK falls back to a public join on first CHANNEL_ERROR
// (see signaling-supabase.ts openChannel), so a private-by-default app still reaches a
// robot that hasn't been flipped to NORI_PRIVATE_ROOM=1. Force a public join for dev
// against a deliberately-public robot via:
//   localStorage.setItem("nori_private_room", "0"); location.reload();
export function isPrivateRoomEnabled(): boolean {
  try {
    return localStorage.getItem("nori_private_room") !== "0";
  } catch {
    return true;
  }
}
