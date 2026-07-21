# Your first session

## Setting up and Driving
1. Power on the robot with the switch on the back. Expect the screen to light up and a chime to play. Booting up will take around 30s, at the end of which your Nori's eyes will show up.
2. First step is always to connect to Wifi: find it by tapping on Nori's face, navigating to Settings, Wifi, then wait as local networks are discovered. Select your one and enter the password.
3. Sign up/in on the Nori app, and pair the robot at the Pairing page, using your secret pair code and the serial number (found on the back of Nori's head just above the neck). You may also grant your Nori a nickname on this page.
4. Connect to your Nori on the landing page (Nori logo) or anywhere on the Remote Operation, Coding or Agent pages (connection persists within the app).
5. It may take a few seconds to connect. Once your see it light up green, check telemetry: you will see stats from the robot, its safety status, your connection, and more. Remember to take off any camera covers that your Nori may have been shipped with.
6. Drive it: the keyboard control panel is the easiest way to get started. Make sure you're focused on the page, and give it a try. Tweak sensitivity at any time to moderate the speed.
7. To stop, just disconnect at any time. 
8. Nori will automatically sleep after being left idle, and will be woken up by a tap of your finger on Nori's face, or by connecting via the app. Powering off is not necessary between sessions within a day or two, but prolonged sleeping can still drain your battery.

## The one thing to know before you move an arm

The robot has two different kinds of E-stop:

- The **physical E-stop** cuts electrical power to the motors only. The robot's computer and other
  non-motor systems stay powered. A raised arm can go limp and fall when motor power is removed.
- The **software E-stop**, available in the app or through `teleop.command("estop")`, blocks motion
  and latches while leaving motor torque engaged.

The **master switch** is different again: it controls power to the entire robot.

Clearing a software E-stop is deliberate and nothing else does it for you: `reset_latch`. That's
the design — a latch you can clear by accident isn't a latch. Releasing the physical E-stop is
required to restore motor power; a software command cannot restore power that the physical E-stop
has cut.

**The robot can also latch itself.** A servo that gets too hot, or a joint that pulls too much
current for too long, has its torque cut and latched off to save the motor — no human involved.
That joint goes **limp**, so a raised arm can drop. Read `latch_reason` to tell the cases apart
before you reset.

Full behavior in [the safety contract](/sdk/safety) and [safety states](/troubleshooting/safety-states).

## If it doesn't connect

The single most common failure is a session that sits at `connecting` and never reaches
`connected`. That's almost always the network, not you — see
[Connection troubleshooting](/troubleshooting/connection).
