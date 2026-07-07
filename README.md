<h1 align="center">🦾 LeLab</h1>

<p align="center">
  <b>The official graphical interface for <a href="https://github.com/huggingface/lerobot">LeRobot</a>.</b>
</p>

<div align="center">

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://github.com/huggingface/leLab/blob/main/LICENSE)
[![HF Space](https://img.shields.io/badge/🤗-Open%20in%20Spaces-yellow)](https://huggingface.co/spaces/lerobot/LeLab)
[![Discord](https://img.shields.io/badge/Discord-Join_Us-5865F2?style=flat&logo=discord&logoColor=white)](https://discord.gg/q8Dzzpym3f)

</div>

**LeLab** is a web app that puts the full LeRobot workflow — calibrate, teleoperate, record, train, replay — into a single browser UI. Plug in your arm, open the app, and go. No CLI gymnastics, no keyboard prompts.

🤗 A web-native front door to LeRobot, designed so newcomers can get from "unboxing" to "training their first policy" in minutes.

🤗 Install and run everything with a single command.

## Quick Start

Grab the one-liner from the [LeLab Space](https://huggingface.co/spaces/lerobot/LeLab) — it installs and runs LeLab + LeRobot in a single command.

A page will automatically open in your browser and you are ready to go.

## Dev Quickstart (run from source)

For developers who want to run the current `main` against real arms. This installs LeLab +
its pinned LeRobot build and drops you at the `lelab` command.

> **Not on PyPI.** LeLab pins `lerobot` to a specific git commit, which PyPI forbids, so
> `pip install lelab` will never work — install from git (below).

**Prerequisites**

- **Python ≥ 3.12** (hard requirement — 3.11 and older will fail to install).
- **Node ≥ 22** — only if you plan to rebuild the UI or run `--dev`. The built frontend is
  committed, so a plain run needs no Node.
- A machine physically connected to the SO-101 arm(s) over USB. Serial + camera access are
  local; there is no cloud fallback for the control loop.

**Install**

Using [`uv`](https://docs.astral.sh/uv/) (recommended — fetches the right Python for you):

```bash
uv tool install "git+https://github.com/Nori-Robotics/Nori-Lab.git"
```

Or with `pipx` (uses your system Python, so 3.12+ must already be on PATH):

```bash
pipx install "git+https://github.com/Nori-Robotics/Nori-Lab.git"
```

If you're going to **edit the code**, clone and install editable instead:

```bash
git clone https://github.com/Nori-Robotics/Nori-Lab.git
cd Nori-Lab
pip install -e .          # add ".[dev]" or ".[test]" for lint / tests
```

**Configure (only needed for Nori cloud features)**

Calibrate and teleoperate work with no config. Dataset upload, training dispatch, and policy
download go through Nori-Backend and need a `.env` in the repo root:

```bash
cp .env.example .env      # then fill in NORI_BACKEND_URL, SUPABASE_URL, SUPABASE_ANON_KEY
```

**Run**

```bash
lelab                     # API + UI on :8000, opens your browser
lelab --dev               # Vite HMR on :8080 + uvicorn --reload on :8000 (needs Node)
```

## What you can do

<div align="center">
  <table>
    <tr>
      <td>🎯 <b>Calibrate</b></td>
      <td>Guided web flow for both arms — no keyboard prompts.</td>
    </tr>
    <tr>
      <td>🕹️ <b>Teleoperate</b></td>
      <td>Move the leader, the follower mirrors it. Live joint streaming.</td>
    </tr>
    <tr>
      <td>📹 <b>Record</b></td>
      <td>Capture episodes into a LeRobotDataset, with cameras.</td>
    </tr>
    <tr>
      <td>🧠 <b>Train</b></td>
      <td>Kick off a LeRobot training job, watch logs live.</td>
    </tr>
    <tr>
      <td>🤖 <b>Run inference</b></td>
      <td>Execute a trained policy on the follower.</td>
    </tr>
    <tr>
      <td>⏪ <b>Replay</b></td>
      <td>Re-run any recorded episode.</td>
    </tr>
    <tr>
      <td>☁️ <b>Upload</b></td>
      <td>Push your dataset to the <a href="https://huggingface.co/">Hugging Face Hub</a> in one click.</td>
    </tr>
  </table>
</div>

## Resources

- **[LeRobot](https://github.com/huggingface/lerobot):** the underlying library — go here for everything beyond the UI.
- **[LeLab Space](https://huggingface.co/spaces/lerobot/LeLab):** try the UI in your browser.
- **[Discord](https://discord.gg/q8Dzzpym3f):** chat with the LeRobot community.
- **[CLAUDE.md](CLAUDE.md):** architecture rundown for contributors.

## Contribute

PRs welcome. Hot-reload mode for working on the code:

```bash
lelab --dev
```

Vite on `:8080`, uvicorn `--reload` on `:8000`.

## Nori L2 Dual Leader Setup

Nori L2 leader setup is local to the laptop and talks only to the two USB leader arms.
Both leaders are expected on one shared Feetech USB bus.

```bash
python -m lelab.nori_leader_setup plan
python -m lelab.nori_leader_setup ports --save
python -m lelab.nori_leader_setup set-id --wizard --side left
python -m lelab.nori_leader_setup set-id --wizard --side right
python -m lelab.nori_leader_setup calibrate --mode manual --side both
```

The same flow is available in the UI at `/nori/leader-setup` and from the normal
Calibration page. Calibration is saved under:

```text
~/.cache/huggingface/lerobot/calibration/teleoperators/nori_l2_dual_leader/
```

<div align="center">
<sub>Originally hacked together by <a href="https://www.linkedin.com/posts/nicolas-rabault-_lerobot-hackathon-lerobot-ugcPost-7341065019368828930-jTnl/">Team LeLab at the 2025 LeRobot Worldwide Hackathon 🏆</a>, now maintained by the <a href="https://huggingface.co/lerobot">LeRobot</a> team at <a href="https://huggingface.co">Hugging Face</a> with ❤️</sub>
</div>
