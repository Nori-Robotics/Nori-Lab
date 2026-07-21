# Troubleshooting: start here

Find your symptom. Each links to the page that fixes it.

| Symptom | Likely cause | Go to |
|---|---|---|
| Session stuck at `connecting`, never reaches `connected` | Strict network — needs a TURN relay | [Connection](/troubleshooting/connection) |
| Connected, but no video | Room mismatch, or the encoder is paused | [Connection](/troubleshooting/connection) |
| Video is low-res / low-fps | Working as intended — it's the robot's power budget | [Connection](/troubleshooting/connection#video-quality) |
| App can't see a leader arm | Charge-only cable, or a hub swallowing it | [Leader arms and USB](/troubleshooting/leader-arms) |
| An arm moves the wrong joint / wrong direction | Motor IDs, or stale calibration | [Leader arms and USB](/troubleshooting/leader-arms) |
| "Enter VR" is disabled | Not a secure context (needs HTTPS) | [VR](/troubleshooting/vr) |
| No audio after joining a call | Autoplay policy, or the robot-side consent prompt | [Audio](/troubleshooting/audio) |
| Robot's speaker disconnects mid-clip | Brownout — the clip was too loud | [Power and brownouts](/troubleshooting/power) |
| A camera vanishes mid-session | USB current cap on the Pi | [Power and brownouts](/troubleshooting/power) |
| One joint stopped, the rest still work | A **stall**. Working as designed | [Safety states](/troubleshooting/safety-states) |
| Everything stopped and won't restart | Something is **latched** — E-STOP, or motor protection | [Safety states](/troubleshooting/safety-states) |
| The robot latched itself, nobody touched it | Over-temp or over-current motor protection | [Safety states](/troubleshooting/safety-states) |
| A joint went limp and won't re-engage | Its torque was cut to save the motor. Needs `reset_latch` | [Safety states](/troubleshooting/safety-states) |
| A motor shows red or amber in the app | Hardware fault vs. not answering the bus — different fixes | [Safety states](/troubleshooting/safety-states#motor-faults) |
| Camera fps falls off over a long session | Thermal throttling, not power. Needs cooling | [Power and brownouts](/troubleshooting/power) |
| Desktop app opens to a blank window | Backend didn't come up on `:8000` | [Desktop app](/troubleshooting/desktop) |

## Before you dig in

Three checks that resolve a large share of reports:

**Is the robot actually reporting `safety: ok`?** A robot in `safe_hold` or `latched` isn't broken
— it's refusing to move on purpose, and it'll tell you why. [Safety states](/troubleshooting/safety-states).

**Is it a power problem wearing a software costume?** Cameras that vanish, speakers that
disconnect, arms that stop responding — these are frequently the Pi's USB rail running out of
current, not a bug. [Power and brownouts](/troubleshooting/power).

**Is it the cable?** A charge-only USB cable is physically identical to a data cable and is the
single most common cause of "the app can't see my arm."

## Still stuck?

[Getting help](/troubleshooting/getting-help) — what to send us so we can actually diagnose it.
