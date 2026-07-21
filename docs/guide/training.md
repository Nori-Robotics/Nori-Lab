# Recording and training

Record demonstrations by teleoperating the robot, then train a policy on them and run it back.

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
- **Recording a dataset.** Starting/stopping an episode, what a good episode looks like, how many
  you need before training is worth attempting.
- **Editing a dataset.** Dropping bad episodes.
- **Training.** Training is **cloud-dispatched** — it does not run on your laptop, and the
  desktop app deliberately doesn't ship a local training runner. Cover: launching a job, what the
  live monitor shows, how long to expect, and reading the loss curve.
- **Training history** and picking a checkpoint.
- **Inference.** Inference runs **locally** — torch ships inside the desktop bundle on purpose,
  so the motor-command loop never depends on Wi-Fi. Cover: loading a policy, running it,
  stopping it safely.
- **Marketplace.** Publishing a policy and using someone else's.
:::
-->

## Why training is cloud and inference is local

Worth stating, because it explains two things people ask about:

**Inference is local** — which is why the desktop download is ~770 MB rather than ~200 MB. A
robot's motor-command loop must not depend on your Wi-Fi holding up. That size is a deliberate
trade, not an oversight.

**Training is cloud** — it needs GPUs you don't have, and it's not latency-sensitive. Nothing
about training touches the robot.
