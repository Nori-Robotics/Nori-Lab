// @nori/sdk — minimal example: connect, show video, log telemetry, jog from the keyboard.
//
// This is browser code (WebRTC + DOM). Run it through any bundler (Vite/webpack/esbuild) in a
// page that has a <video> element. Fill in the CONFIG your Nori contact provides.
//
//   import { runMinimalTeleop } from "@nori/sdk/examples/minimal";
//   runMinimalTeleop(document.querySelector("video")!);

import { RemoteTeleop, NORI_PROTOCOL_VERSION } from "@nori/sdk";
import { SupabaseSignaling } from "@nori/sdk/supabase";
import { createClient } from "@supabase/supabase-js";

// --- provisioned for you (a room, NOT a Supabase login) ------------------------------------
const CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-KEY",
  ROOM: "nori-dev",
  STUN: "stun:stun.l.google.com:19302",
  TURN_URLS: [] as string[], // e.g. ["turn:turn.example.com:3478"] for WAN; empty = same-LAN only
  TURN_USER: "",
  TURN_CRED: "",
};

export function runMinimalTeleop(videoEl: HTMLVideoElement) {
  console.log(`nori-sdk targeting protocol v${NORI_PROTOCOL_VERSION}`);
  const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

  const teleop = new RemoteTeleop({
    signaling: new SupabaseSignaling(supabase, CONFIG.ROOM, (...m) => console.log("[sig]", ...m)),
    videoEl,
    stun: CONFIG.STUN,
    turnUrls: CONFIG.TURN_URLS,
    turnUser: CONFIG.TURN_USER,
    turnCred: CONFIG.TURN_CRED,
    forceRelay: false,
    arm: "right",
    onLog: (m) => console.log("[teleop]", m),
    onConnState: (s) => console.log("[conn]", s),
    // The daemon's handshake ack — the robot describing itself. Also readable at any
    // later point via teleop.robotInfo().
    onReady: (info) => {
      if (!info.accepted) { console.error("[ready] robot refused session:", info.error); return; }
      console.log(`[ready] protocol v${info.protocolVersion} units=${info.normMode}`,
        "joints:", info.descriptor?.joints?.length, "cameras:", info.descriptor?.cameras);
    },
    onTelemetry: (t) => {
      // ~50 Hz. `state` holds every joint's normalized "<motor>.pos" plus lift height in mm.
      const lift = t.state["right_lift.pos"];
      console.log(`safety=${t.safety} loopHz=${t.loopHz} tempC=${t.tempC}` +
        (typeof lift === "number" ? ` rightLift=${lift.toFixed(0)}mm` : ""));
    },
    onMode: (mode) => console.log("[mode]", mode),
    onControlActive: (active) => console.log("[control]", active ? "ACTIVE" : "idle"),
  });

  // Keyboard control. `onKeyDown` returns true when it consumed the key (so you can preventDefault).
  const down = (e: KeyboardEvent) => { if (teleop.onKeyDown(e)) e.preventDefault(); };
  const up = (e: KeyboardEvent) => teleop.onKeyUp(e);
  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);

  teleop.start();

  // Programmatic jog alternative (normalized rate in [-1,1] per DOF), e.g. from a gamepad:
  //   teleop.setExternalJog({ right_arm: { shoulder_pan: 0.5 }, right_lift: 0.2 });
  //   teleop.setExternalJog(null); // stop

  // Call to tear down (also removes the key listeners):
  return async function stop() {
    window.removeEventListener("keydown", down);
    window.removeEventListener("keyup", up);
    await teleop.stop();
  };
}
