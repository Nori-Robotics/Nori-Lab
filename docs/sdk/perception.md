# Perception

Structured world-state — separate from the video track (human eyes) and from a one-shot LLM-vision
still.

`perceive()` returns the latest **structured** detections from the daemon's on-Pi perception
process, so a *running* program can react to what the robot sees.

```ts
const world = teleop.perceive();               // PerceptionView | null (null = no frame yet)
const cup = world?.objects.find((o) => o.label === "cup");
if (cup?.xyz && (teleop.perceptionAgeMs() ?? Infinity) < 500) {
  // cup.xyz is [x,y,z] in robot-base meters; cup.bbox is normalized [x,y,w,h]. Both optional —
  // present depends on the detector (2D vs depth). Check age: a dead detector leaves a stale frame.
}
```

Subscribe instead of polling with the `onPerception` option.

## Two kinds of "nothing"

Don't conflate them:

- **`objects: []`** — an explicit "nothing seen". The detector ran and found no objects.
- **`null`** — no frame at all. The detector hasn't reported.

And check the **age**: a dead detector leaves its last frame sitting in the cache, so a stale
`PerceptionView` looks exactly like a fresh one until you call `perceptionAgeMs()`.

Frames ride the control channel (`type: "perception"`, nori-protocol `perception.json`).

::: warning Verification status (v0)
The SDK's parse/cache/`perceive()`/`injectPerception()` surface is implemented and unit-tested, but
the **on-Pi detector that emits `perception` frames does not exist yet** — `perceive()` returns
`null` on real hardware today.

`injectPerception()` feeds synthetic frames through the same path for development, so you can
build and test against the real API shape now.
:::
