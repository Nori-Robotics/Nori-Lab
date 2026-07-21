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

`throttled=0x0` is healthy. Anything else is the firmware telling you what went wrong:

| Bit | Value | Meaning |
|---|---|---|
| 0 | `0x1` | **Undervoltage right now.** The live signal — this is the one to watch. |
| 1 | `0x2` | Arm frequency capped now. |
| 2 | `0x4` | Currently throttled. |
| 3 | `0x8` | Soft temperature limit active now. |
| 16 | `0x10000` | Undervoltage **has occurred** since boot. |
| 17 | `0x20000` | Frequency cap has occurred since boot. |
| 18 | `0x40000` | Throttling has occurred since boot. |
| 19 | `0x80000` | Soft temp limit has been hit since boot. |

So `0x50000` = "undervoltage and throttling both happened at some point since boot"; `0xe0000` =
"frequency-capped, throttled, and soft-temp-limited since boot" — a **thermal** history, not a
power one. That distinction matters: a Pi dropping camera frames with `0xe0000` and no bit 0 needs
**cooling**, not a bigger supply.

::: warning The high bits are sticky until reboot
Bits 16–19 persist for the life of the boot, so a sag from yesterday pollutes today's reading.
**Reboot before you measure**, then watch **bit 0** (the reading ending in an odd digit) in a live
loop — that's the real-time signal.
:::

Log it alongside temperature and the 5 V rail while you reproduce:

```bash
while true; do
  printf '%s  %s  %s  5V=%s\n' "$(date +%T)" "$(vcgencmd get_throttled)" \
    "$(vcgencmd measure_temp)" \
    "$(vcgencmd pmic_read_adc | grep -E 'EXT5V_V' | awk '{print $2}')"
  sleep 2
done
```

`EXT5V_V` sagging below **~4.8 V** under load means the rail is marginal — note which activity did
it.

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
