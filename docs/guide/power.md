# Power and cabling

Power is the root cause of a surprising share of "the robot is flaky" reports. Symptoms that look
like software — a camera that vanishes mid-session, a speaker that disconnects, an arm that stops
responding — are often the Pi's USB rail running out of current.

## Electrical specifications

| System | Specification |
|---|---|
| Battery | Two 24 V lithium-ion batteries connected in parallel |
| Total battery capacity | 576 Wh |
| Motor supply | 12 V, 40 A maximum |
| Required charger | 24 V lithium-ion battery charger |
| Included charger | 24 V, 2 A |
| Maximum battery charging rate | 4 A |

The two batteries form one 24 V pack: connecting them in parallel increases capacity, not
voltage. All motors run from the robot's 12 V motor supply. The 40 A figure is the maximum for the
motor power system, not a per-motor rating.

::: danger Use only a compatible 24 V lithium-ion charger
The robot includes a 24 V, 2 A charger. Do not exceed the battery pack's 4 A maximum charging
rate, and do not use a charger intended for a different voltage or battery chemistry.
:::

## Power controls

The two physical power controls do different jobs:

- **Master switch:** turns power to the entire robot on or off.
- **Physical E-stop:** cuts power only to the motors. The robot's computer and other non-motor
  systems remain powered.

Use the master switch for a complete shutdown. Use the physical E-stop when motor power must be
removed immediately. The app and SDK also provide a separate **software E-stop**; it blocks motion
but does not replace the physical motor-power cutoff.

## Charging

Charge the robot with a compatible 24 V lithium-ion battery charger. A 24 V, 2 A charger is
included with the robot. The battery supports charging at up to 4 A; never use a charger that
exceeds that rate.

## The rules

**The Pi 5 caps aggregate USB current at 600 mA** unless it's explicitly told the supply can do
more. On a robot Pi this must be raised, or peripherals will brown out under load:

```
usb_max_current_enable=1
```

**Use a powered USB hub** for anything hungry — speakerphones especially.

**Motor torque is limited** so that a peak draw stays within the motor power system's limits.

**Confirm rather than guess.** `vcgencmd get_throttled` on the Pi tells you whether you're
actually looking at a power problem — and distinguishes an undervoltage history from a *thermal*
one, which needs cooling instead. [Bit-by-bit decode](/troubleshooting/power#confirming-it-rather-than-guessing).

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
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
