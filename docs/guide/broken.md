# Something's broken

Find your symptom. Each links to the section that fixes it — every fix now lives on the same page
as the setup for that topic.

| Symptom | Likely cause | Go to |
|---|---|---|
| Session stuck at `connecting`, never reaches `connected` | Strict network — needs a TURN relay | [Remote](/guide/remote#connection-trouble) |
| Connected, but no video | Room mismatch, or the encoder is paused | [Remote](/guide/remote#connection-trouble) |
| Video is low-res / low-fps | Working as intended — it's the robot's power budget | [Cameras](/guide/cameras#video-quality) |
| Camera fps falls off over a long session | Thermal throttling, not power. Needs cooling | [Cameras](/guide/cameras) |
| A camera vanishes mid-session | USB current cap on the Pi | [Power](/guide/power#brownouts) |
| App can't see a leader arm | Charge-only cable, or a hub swallowing it | [Leader arms](/guide/leader-arms#when-it-goes-wrong) |
| An arm moves the wrong joint / wrong direction | Motor IDs, or stale calibration | [Leader arms](/guide/leader-arms#when-it-goes-wrong) |
| "Enter VR" is disabled | Not a secure context (needs HTTPS) | [VR](/guide/vr#when-it-goes-wrong) |
| No audio after joining a call | Autoplay policy, or the robot-side consent prompt | [Audio](/guide/audio) |
| Robot's speaker disconnects mid-clip | Brownout — the clip was too loud | [Power](/guide/power#brownouts) |
| One joint stopped, the rest still work | A **stall**. Working as designed | [Safety states](/guide/safety-states) |
| Everything stopped and won't restart | Something is **latched** — E-STOP, or motor protection | [Safety states](/guide/safety-states) |
| The robot latched itself, nobody touched it | Over-temp or over-current motor protection | [Safety states](/guide/safety-states) |
| A joint went limp and won't re-engage | Its torque was cut to save the motor. Needs `reset_latch` | [Safety states](/guide/safety-states) |
| A motor shows red or amber in the app | Hardware fault vs. not answering the bus — different fixes | [Safety states](/guide/safety-states#motor-faults) |
| The computer is on but every motor is dead | The physical E-stop is engaged | [Safety states](/guide/safety-states) |
| Desktop app opens to a blank window | Backend didn't come up on `:8000` | [Install](/guide/install#when-it-goes-wrong) |

## Before you dig in

Three checks that resolve a large share of reports:

**Is the robot actually reporting `safety: ok`?** A robot in `safe_hold` or `latched` isn't broken
— it's refusing to move on purpose, and it'll tell you why. [Safety states](/guide/safety-states).

**Is it a power problem wearing a software costume?** Cameras that vanish, speakers that
disconnect, arms that stop responding — these are frequently the Pi's USB rail running out of
current, not a bug. [Brownouts and throttling](/guide/power#brownouts).

**Is it the cable?** A charge-only USB cable is physically identical to a data cable and is the
single most common cause of "the app can't see my arm."

## Still stuck?

[Getting help](/guide/getting-help) — what to send us so we can actually diagnose it.
