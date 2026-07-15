// NORI: Additive file. DEV-ONLY mock perception source (docs/phase_f_perception.md).
//
// Phase F's real perception frames come from an on-Pi detector that doesn't exist yet. This feeds
// synthetic `perception` frames through the SAME path a real one takes (teleop.injectPerception),
// so the team can write + test reactive scripts (nori.perceive()) against a moving target today.
// It is NOT wired on by default — the Coding page exposes a "provide perception" toggle that
// starts/stops this. Nothing here ships in a real robot session.
//
// The scene: a "cup" that drifts left<->right across the frame at ~0.1 Hz, plus a "hand" that
// blinks in for a couple seconds every ~8 s (so a script can practice yielding when a hand appears).
// Deterministic from a tick counter — no Math.random — so a demo replays the same way.

import type { RemoteTeleop, PerceivedObject } from "@nori/sdk";

const RATE_HZ = 5; // ~2-10 Hz is the realistic band; 5 keeps the demo lively but not chatty

export interface MockPerceptionHandle {
  stop(): void;
}

export function startMockPerception(teleop: RemoteTeleop): MockPerceptionHandle {
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    const t = tick / RATE_HZ; // seconds

    // Cup drifts across the frame; give it a plausible robot-frame xyz too (depth detector).
    const cx = 0.5 + 0.3 * Math.sin(2 * Math.PI * 0.1 * t); // normalized center-x
    const objects: PerceivedObject[] = [
      {
        label: "cup",
        confidence: 0.9,
        bbox: [cx - 0.06, 0.5, 0.12, 0.2],
        xyz: [0.35, (cx - 0.5) * 0.6, 0.08], // y tracks the horizontal offset
        id: 1,
      },
    ];

    // A hand blinks in for ~2 s out of every ~8 s (period = 40 ticks at 5 Hz).
    if (tick % 40 < 10) {
      objects.push({ label: "hand", confidence: 0.8, bbox: [0.7, 0.3, 0.18, 0.25] });
    }

    teleop.injectPerception({ source: "mock", objects });
  }, 1000 / RATE_HZ);

  return { stop: () => clearInterval(timer) };
}
