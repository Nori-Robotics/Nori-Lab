# Leader arms (Nori L2)

The leader arms are the physical pair you hold to puppet the robot's follower arms. They plug
into your laptop over USB and are driven by the desktop app.

This is the setup that most often needs troubleshooting, because it's the one that touches
serial ports, USB hubs, and motor IDs.

## How the app sets them up

The desktop app has a leader-setup wizard (`/nori/leader-setup`) that walks the whole thing.
The same steps exist as a CLI, which is useful when the wizard can't see an arm:

```bash
python -m lelab.nori_leader_setup plan          # what needs doing
python -m lelab.nori_leader_setup ports --save   # find and remember the serial ports
python -m lelab.nori_leader_setup set-id --wizard  # assign motor IDs
python -m lelab.nori_leader_setup calibrate      # calibrate the arms
```

Calibration lands in:

```
~/.cache/huggingface/lerobot/calibration/teleoperators/nori_l2_dual_leader/
```

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
- **Motor IDs.** Both arms share a serial bus, so every motor needs a unique ID before anything
  works. Explain the ID scheme, and why a fresh motor out of the box always needs this.
- **Calibration.** What the wizard asks you to do physically (move each joint through its range),
  what "good" looks like, and when you need to redo it.
- **Which arm is which.** How left/right is determined and what to do when they're swapped.
- Screenshots of each wizard step.
:::
-->

## The three gotchas

Almost every leader-arm problem is one of these. They're worth knowing before you start, and
they're the first things to check when something breaks.

**A charge-only USB cable looks exactly like a data cable.** It carries no data lines, and it is
the single most common cause of "no arm found."

**Hubs swallow devices.** An unpowered hub, or a hub daisy-chained off another hub, will
intermittently drop the arms.

**Calibration is cached on disk** and reused across sessions. An arm that behaves as though it's
calibrated for a *different* arm usually is.

## When it goes wrong

### The app says no leader arm is found

Rule these out in order — listed by how often they're the answer.

**1. The cable is charge-only.** Swap it for a cable you *know* carries data.

**2. A hub is swallowing it.** **Plug the arm directly into the laptop** while debugging — add the
hub back only once it works.

**3. It's genuinely unplugged.** Worth actually checking.

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
- What a healthy detection looks like in the app.
- How to list serial ports by hand per OS (`ls /dev/tty.*` on macOS, Device Manager on Windows),
  and what the arms show up as.
- Driver requirements, if any, per OS.
:::
-->

If the wizard still can't see it, the CLI takes the same steps and is more verbose:

```bash
python -m lelab.nori_leader_setup ports --save
```

### Only one of the two arms is found

Both arms **share a serial bus**. If two motors have the same ID, they collide and the bus
misbehaves — which frequently looks like "one arm is missing" rather than a clean error.

Re-run the ID assignment:

```bash
python -m lelab.nori_leader_setup set-id --wizard
```

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
Explain the ID scheme and why a motor fresh out of the box always needs an ID assigned before
anything works.
:::
-->

### The wrong joint moves, or a joint moves backwards

Two candidates:

**Motor IDs are wrong.** If a motor has the ID that belongs to a different joint, commands land on
the wrong joint. Re-run `set-id --wizard`.

**Calibration is stale.** An arm calibrated for a different arm — or before a mechanical change —
will behave consistently wrongly. Re-run calibration:

```bash
python -m lelab.nori_leader_setup calibrate
```

::: warning Suspect the cache before the hardware
A stale calibration file produces symptoms that look exactly like a broken arm. If an arm started
misbehaving without anything physically changing, check the cache first.
:::

### The arms disconnect randomly during a session

Usually power or the hub, not the arms. See [Power and cabling](/guide/power#brownouts).
