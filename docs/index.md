---
layout: home

hero:
  name: Nori
  text: Docs & troubleshooting
  tagline: Set up a robot, drive it from anywhere, and build on top of it with the @nori/sdk.
  image:
    src: /nori-logo.png
    alt: Nori
  actions:
    - theme: brand
      text: Get started
      link: /guide/
    - theme: alt
      text: SDK reference
      link: /sdk/
    - theme: alt
      text: Something is broken
      link: /troubleshooting/

features:
  - title: Guide
    details: Install the desktop app, set up your leader arms and cameras, and run your first teleop session.
    link: /guide/
    linkText: Start here
  - title: SDK
    details: Connect to a robot over WebRTC, stream video and telemetry, and drive it from the browser in ~20 lines. The robot defends itself.
    link: /sdk/
    linkText: Read the SDK docs
  - title: Troubleshooting
    details: Connection stuck at "connecting", no video, an arm the app can't see, a robot that browns out. Symptom-first fixes.
    link: /troubleshooting/
    linkText: Fix it
---

## New here?

- **You have a robot and want to drive it.** → [Install the desktop app](/guide/install), then
  [run your first session](/guide/first-session).
- **You're writing software against a robot.** → [SDK quick start](/sdk/quickstart). Read
  [the safety contract](/sdk/safety) before you ship anything that moves an arm.
- **Something is broken right now.** → [Troubleshooting](/troubleshooting/).

## Status

Nori is `v0` and ships to a small set of collaborating teams. Pages carry a **Status** note
where the software is ahead of the hardware, or where a surface is implemented but not yet
verified on a real robot — those notes are load-bearing, not boilerplate. If a page contradicts
what your robot actually does, that's a bug in the docs: [tell us](/troubleshooting/getting-help).
