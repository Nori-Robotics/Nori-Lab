# Power and cabling

Power is the root cause of a surprising share of "the robot is flaky" reports. Symptoms that look
like software — a camera that vanishes mid-session, a speaker that disconnects, an arm that stops
responding — are often the Pi's USB rail running out of current.

## The rules

**The Pi 5 caps aggregate USB current at 600 mA** unless it's explicitly told the supply can do
more. On a robot Pi this must be raised, or peripherals will brown out under load:

```
usb_max_current_enable=1
```

**Use a powered USB hub** for anything hungry — speakerphones especially.

**Motor torque is limited** so that a peak draw doesn't trip the power station.

**Confirm rather than guess.** `vcgencmd get_throttled` on the Pi tells you whether you're
actually looking at a power problem — and distinguishes an undervoltage history from a *thermal*
one, which needs cooling instead. [Bit-by-bit decode](/troubleshooting/power#confirming-it-rather-than-guessing).

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
- The actual supported power configurations (battery, power station, wall).
- A cabling diagram: what plugs into what, and which ports are current-limited.
- Speaker specifics: a near-full-scale audio clip can brown out a USB DSP speakerphone into a
  mid-stream re-enumeration. The robot clamps playback gain (default `0.7`) to defend against
  this — see [SDK: Audio](/sdk/audio).
:::
-->

## Devices that re-enumerate

When a USB device browns out and comes back, it comes back as a **new card number**. Anything
configured by number (`hw:0`) is then pointing at nothing, permanently, until you restart.

This is why the robot's speaker must be configured by **name** — a dmix alias (`nori_out`) or
`hw:CARD=<name>`, never `hw:<number>`.

Debugging a brownout: [Power and brownouts](/troubleshooting/power).
