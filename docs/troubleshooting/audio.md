# Audio

## No audio after joining a call

Two very different causes — check them in this order.

**The robot is waiting for consent.** This is by design and is not a bug. Robots gate their room
microphone behind a **local accept prompt**: a person *at the robot* must accept before an operator
can hear the room. Until someone accepts, you get silence.

If nobody is standing next to the robot, nobody can accept, and you will hear nothing forever.
That's the intended behavior.

**Browser autoplay policy.** Browsers refuse to play inbound audio without a user gesture. If the
audio element was never attached to a real click, the stream arrives and is silently not played.

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
The exact gesture requirement per browser, and the recommended pattern (attach the audio sink from
a click handler).
:::
-->

## `sendClipAudio` returns `false` and nothing plays

The robot's **voice downlink is off**. Only when it's on (`webrtc_robot.py --voice` / `NORI_VOICE`,
plus a speaker present) is the audio m-line `sendrecv` and the robot willing to play what you send.

## The clip plays, but quieter than I sent it

Working as intended. **The robot clamps playback gain** (`NORI_SPEAKER_GAIN`, default `0.7`) with a
volume element before the sink. No track you send can overdrive the speaker.

This is a robot-side guarantee on purpose — it doesn't depend on the client behaving. See
[SDK: Audio](/sdk/audio).

## The speaker disconnects mid-clip

You browned it out. A near-full-scale clip drives the speaker amp and the hardware-AEC reference
far harder than call speech — hard enough, on a full-speed USB DSP speakerphone, to trigger a
**mid-stream USB re-enumeration**. The tell is `alsasink … device has been disconnected` repeating
in the robot logs.

Quiet call voice never triggers this. Loud clips do.

Fixes, in order of effectiveness:

1. **Attenuate the clip client-side** as well (the robot already caps at `0.7`; go lower).
2. **Use a powered USB hub.**
3. **Use a more robust speaker.**

## The speaker never comes back after a disconnect

Because it came back as a **different card number**. A USB device that re-enumerates gets a new
number, so anything configured as `hw:<number>` is now pointing at nothing — permanently, until a
restart.

**Configure the speaker by name**, never by number: set `NORI_SPEAKER` to a dmix alias (`nori_out`)
or `hw:CARD=<name>`.

More: [Power and brownouts](/troubleshooting/power).
