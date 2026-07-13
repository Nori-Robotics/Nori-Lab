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

::: info 🚧 To write
- **Motor IDs.** Both arms share a serial bus, so every motor needs a unique ID before anything
  works. Explain the ID scheme, and why a fresh motor out of the box always needs this.
- **Calibration.** What the wizard asks you to do physically (move each joint through its range),
  what "good" looks like, and when you need to redo it.
- **Which arm is which.** How left/right is determined and what to do when they're swapped.
- Screenshots of each wizard step.
:::

## The gotchas that bite people

**A charge-only USB cable looks exactly like a data cable.** If the app says no arm is found, this
is the first thing to rule out — it's the single most common cause.

**Hubs swallow devices.** An unpowered hub, or a hub daisy-chained off another hub, will
intermittently drop the arms. Plug the arms directly into the laptop when debugging.

**Calibration is cached.** If an arm behaves as though it's calibrated for a different arm,
suspect a stale calibration file before you suspect the hardware.

Full symptom list: [Leader arms and USB troubleshooting](/troubleshooting/leader-arms).
