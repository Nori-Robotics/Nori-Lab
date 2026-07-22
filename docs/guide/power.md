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
but does not replace the physical motor-power cutoff. See
[Safety states](/guide/safety-states) for how the two differ in what happens to motor torque.

## Charging

Charge the robot with a compatible 24 V lithium-ion battery charger. A 24 V, 2 A charger is
included with the robot. The battery supports charging at up to 4 A; never use a charger that
exceeds that rate.

The pack's state of charge is reported to the operator app as `telemetry.batteryPercent` — see
[SDK: Telemetry](/sdk/telemetry#battery).

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
one, which needs cooling instead. [Bit-by-bit decode](#confirming).

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
- A cabling diagram: what plugs into what, and which ports are current-limited.
:::
-->

## Devices that re-enumerate

When a USB device browns out and comes back, it comes back as a **new card number**. Anything
configured by number (`hw:0`) is then pointing at nothing, permanently, until you restart.

This is why the robot's speaker must be configured by **name** — a dmix alias (`nori_out`) or
`hw:CARD=<name>`, never `hw:<number>`.

## Brownouts and throttling {#brownouts}

Read this section whenever a peripheral **disappears** rather than misbehaves. A device that
vanishes mid-session — a camera, the speaker, an arm — is usually being starved of current, not
failing.

### The symptom pattern

You're looking at a brownout if:

- A USB device works, then **disconnects mid-session**, often under load.
- The robot logs show a device **re-enumerating** (`… device has been disconnected`, then a new
  device appearing).
- It's **reproducible under load** (loud audio playback, all cameras streaming, arms moving) and
  fine when idle.

Software bugs don't usually correlate with load like that. Power does.

### Confirming it rather than guessing {#confirming}

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

### Audio clips brown out the speaker

A near-full-scale audio clip drives the speaker amp and the hardware-AEC reference far harder than
call speech. On a full-speed USB DSP speakerphone that's enough to brown the device out into a
mid-stream USB re-enumeration.

The robot already clamps playback gain (`NORI_SPEAKER_GAIN`, default `0.7`) to defend against this.
If you're still hitting it: attenuate further client-side, add a **powered USB hub**, and use a
more robust speaker. More: [Audio](/guide/audio).

### Motor torque and the power station

Motor torque is deliberately limited so a peak draw stays within the motor power system's limits.
If you're seeing the whole robot cut out under aggressive motion rather than a single peripheral
dropping, that's a different problem from a USB brownout — it's the supply rail.

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
- What tripping the supply looks like vs. a USB brownout, so operators can tell them apart.
- Recovery procedure after a trip.
:::
-->
