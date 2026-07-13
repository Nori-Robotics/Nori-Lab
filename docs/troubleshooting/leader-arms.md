# Leader arms and USB

## The app says no leader arm is found

Rule these out in order — they're listed by how often they're the answer.

**1. The cable is charge-only.** A charge-only USB cable is physically identical to a data cable
and carries no data lines. This is the single most common cause. Swap it for a cable you *know*
carries data.

**2. A hub is swallowing it.** Unpowered hubs, and hubs daisy-chained off other hubs, drop devices
intermittently. **Plug the arm directly into the laptop** while debugging — add the hub back only
once it works.

**3. It's genuinely unplugged.** Worth actually checking.

::: info 🚧 To write
- What a healthy detection looks like in the app.
- How to list serial ports by hand per OS (`ls /dev/tty.*` on macOS, Device Manager on Windows),
  and what the arms show up as.
- Driver requirements, if any, per OS.
:::

If the wizard still can't see it, the CLI takes the same steps and is more verbose:

```bash
python -m lelab.nori_leader_setup ports --save
```

## Only one of the two arms is found

Both arms **share a serial bus**. If two motors have the same ID, they collide and the bus
misbehaves — which frequently looks like "one arm is missing" rather than a clean error.

Re-run the ID assignment:

```bash
python -m lelab.nori_leader_setup set-id --wizard
```

::: info 🚧 To write
Explain the ID scheme and why a motor fresh out of the box always needs an ID assigned before
anything works.
:::

## The wrong joint moves, or a joint moves backwards

Two candidates:

**Motor IDs are wrong.** If a motor has the ID that belongs to a different joint, commands land on
the wrong joint. Re-run `set-id --wizard`.

**Calibration is stale.** Calibration files persist on disk and are reused across sessions. An arm
calibrated for a different arm — or before a mechanical change — will behave consistently wrongly.

Calibration lives here:

```
~/.cache/huggingface/lerobot/calibration/teleoperators/nori_l2_dual_leader/
```

Re-run calibration:

```bash
python -m lelab.nori_leader_setup calibrate
```

::: warning Suspect the cache before the hardware
A stale calibration file produces symptoms that look exactly like a broken arm. If an arm started
misbehaving without anything physically changing, check the cache first.
:::

## The arms disconnect randomly during a session

Usually power or the hub, not the arms. See [Power and brownouts](/troubleshooting/power).

Setup guide: [Leader arms (Nori L2)](/guide/leader-arms).
