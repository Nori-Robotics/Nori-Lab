# Power and brownouts

Read this page whenever a peripheral **disappears** rather than misbehaves. A device that vanishes
mid-session — a camera, the speaker, an arm — is usually being starved of current, not failing.

## The symptom pattern

You're looking at a brownout if:

- A USB device works, then **disconnects mid-session**, often under load.
- The robot logs show a device **re-enumerating** (`… device has been disconnected`, then a new
  device appearing).
- It's **reproducible under load** (loud audio playback, all cameras streaming, arms moving) and
  fine when idle.

Software bugs don't usually correlate with load like that. Power does.

## The Pi 5's 600 mA aggregate USB cap

**This is the big one.** A Raspberry Pi 5 limits total USB current across all ports to **600 mA**
unless it is explicitly told the supply can deliver more. On a robot with cameras, arms, and a
speaker, 600 mA is not enough, and peripherals brown out under load.

Robot Pis must set:

```
usb_max_current_enable=1
```

::: info 🚧 To write
- Where exactly this goes and how to verify it took effect.
- Which robot builds ship with it already set, and how to tell.
:::

## Confirming it rather than guessing

On the Pi:

```bash
vcgencmd get_throttled
```

::: info 🚧 To write
Decode the bits — which indicate undervoltage now vs. undervoltage since boot vs. thermal
throttling — and show what a healthy reading looks like. Right now this is the fastest way to
confirm a power problem and it's undocumented for operators.
:::

## Audio clips brown out the speaker

A near-full-scale audio clip drives the speaker amp and the hardware-AEC reference far harder than
call speech. On a full-speed USB DSP speakerphone that's enough to brown the device out into a
mid-stream USB re-enumeration.

The robot already clamps playback gain (`NORI_SPEAKER_GAIN`, default `0.7`) to defend against this.
If you're still hitting it: attenuate further client-side, add a **powered USB hub**, and use a
more robust speaker.

## Devices that come back wrong

When a USB device browns out and re-enumerates, it comes back as a **new card number**. Anything
configured by number (`hw:0`) now points at nothing — permanently, until a restart.

**Configure by name.** For the speaker: `NORI_SPEAKER` must be a dmix alias (`nori_out`) or
`hw:CARD=<name>`, **never `hw:<number>`**.

## Motor torque and the power station

Motor torque is deliberately limited so a peak draw doesn't trip the power station. If you're
seeing the whole robot cut out under aggressive motion rather than a single peripheral dropping,
that's a different problem from a USB brownout — it's the supply rail.

::: info 🚧 To write
- The supported power configurations and their limits.
- What tripping the power station looks like vs. a USB brownout, so operators can tell them apart.
- Recovery procedure after a trip.
:::

Setup: [Power and cabling](/guide/power).
