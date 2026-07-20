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

// Private signaling rooms (signaling Phase 1): join realtime:<serial> as a PRIVATE
// channel so Supabase RLS admits only the robot + its paired customer. DEFAULT ON —
// every connection is private unless explicitly opted out.
//
// ⚠️ HARD CUTOVER (audit C1): the SDK NO LONGER falls back to a public join on error —
// a rejected private join is terminal. So a robot still on the PUBLIC room
// (NORI_PRIVATE_ROOM unset) will NOT connect while this is on. Ship this default only
// once the whole fleet is provisioned + private. The old fallback was removed because
// an RLS denial was indistinguishable from an un-migrated robot, so it silently dropped
// non-paired users onto the victim's public room.
//
// Force a public join for dev against a deliberately-public robot (e.g. `nori-dev`) via:
//   localStorage.setItem("nori_private_room", "0"); location.reload();
export function isPrivateRoomEnabled(): boolean {
  try {
    return localStorage.getItem("nori_private_room") !== "0";
  } catch {
    return true;
  }
}
