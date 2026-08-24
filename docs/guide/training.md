# Training

Turn uploaded recordings into a trainable dataset, train a policy in the cloud, and run it back
locally. Capturing the recordings themselves is covered in
[Video and recording](/guide/video#how-recording-works).

## From recordings to a trainable dataset

A recording isn't trainable by itself. You must **assemble** it from My Stuff, which flattens one or more
recordings into a dataset (a new one, or appended onto an existing one). Datasets are
**LeRobot-format**, so existing training pipelines apply without conversion, and each episode
records the grippers' current draw (raw and normalized) alongside joint positions — a grip-force
signal with no dedicated force sensor. Assembly takes minutes; the dataset is trainable — and
downloadable — as soon as it's done.

## Synthetic maps and relighting (optional)

At assemble time you can enrich a dataset with **derived per-frame maps** ( `depth`, `normals`,
`albedo`, `roughness`) generated from the recorded video (depth from a segmentation pass; the
other three from a single inverse-rendering pass), for all cameras or just the ones you pick. Two
**video-processing** passes are also offered: `color_jitter` and `full_relight` (synthetic
relighting).

Two things to know before ticking the boxes:

- **Map derivation runs on cloud GPUs after assembly** and can take hours for a large selection —
  cost scales per episode × camera, and the assemble dialog quotes the two phases separately. The
  dataset itself is trainable immediately; maps arrive later.
- **Progress and failures show on the dataset card in My Stuff.** A requested map renders muted
  until it's produced; finished maps are downloadable and selectable in the episode viewer.

<!-- TODO-DOCS (hidden from the live site; uncomment to restore)
::: info 🚧 To write
- **What a good episode looks like**, and how many you need before training is worth attempting.
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

## Training and inference

**Inference is local** — which is why the desktop download is ~770 MB rather than ~200 MB. A
robot's motor-command loop must not depend on your Wi-Fi holding up.

**Training is cloud** — it needs GPUs you don't have, and it's not latency-sensitive. Nothing
about training touches the robot.
