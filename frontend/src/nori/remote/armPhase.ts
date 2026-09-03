// NORI: moved into the SDK (packages/nori-sdk/src/armPhase.ts), 2026-09-03.
//
// The in-VR motors panel (vr-session.ts) needs the same arm/disarm sequencing the
// 2D ArmControl renders, and the SDK cannot import from the app. ArmControl.tsx's
// header is explicit that a second copy of this logic "is a second chance to get
// that wrong" — so the logic moved to the one place both can reach, rather than
// being duplicated.
//
// This file stays as a re-export so every existing import path (ArmControl.tsx,
// armPhase.test.ts) keeps working untouched.
export { TRANSITIONAL, NOMINAL, isPreparing, isStuck, isSettled, motorsLabel } from "@nori/sdk";
