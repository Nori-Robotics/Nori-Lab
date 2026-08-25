# Developer posture

::: warning In progress page
Information below is subject to change. If you have questions, [get in touch](/guide/getting-help).
:::

For robotics and ML engineers who want to run their own low-latency control loops right next to
motor control, this posture provides full SSH, open LAN access, and low-level control of all hardware, with nothing
traversing Nori's backend or signaling.

## Overview

**Every robot ships as a default product; going dev is a transition you choose on your own unit.**
It is not a separate SKU — you try the normal product first, then convert. (A small number of
special units [ship already in dev posture](#shipped-as-dev) — if yours did, start there and skip
the transition.)

**The transition is one-way.** It wipes the unit's identity and credentials; there is no
supported field path back (you will have to request us to mail you a new SD card). It is not a
runtime toggle — the posture can never be flipped from the LAN or the touchscreen.

After the transition you own the box: SSH with your own key (you add it at handover; password
auth then turns off; your private key never reaches Nori), an open ROS 2 graph on your LAN, and
your own workspace.

## If your unit shipped as dev {#shipped-as-dev}

Some special units ship already in developer posture, never paired to a Nori account, and have no transition. The first
login uses a one-time password instead of a key handover. Nothing on the unit connects to an
external backend.

1. **Power on.** The face display and settings panel come up, and the motion stack and cameras
   start automatically after a short delay — you'll see battery status and can adjust the lift from the face once that happens.

2. **Get it on your network.** join your Wi-Fi network from the
   on-screen settings panel.

3. **Find it.** By hostname which is your serial number — `nori-model-number.local`, shown on the box — or by its IP from your router.

4. **First login.** SSH in with the one-time password included with your unit. The `dev` account
   has sudo.

   ```bash
   # example:
   ssh dev@nori-a3-0123.local
   ```

5. **Make it yours.** You own this unit — do any of:
   - Add your SSH key (`ssh-copy-id`), then lock down to key-only login:
     `sudo nori-ssh-lockdown` (it won't let you lock yourself out).
   - Or just change the password: `passwd`.
   - Keeping password login on a trusted home network is fine — your call.

6. **Where to go next.** On the unit itself: `~/nori_ws/SETUP.md` (setup, starting and stopping
   the stack) and `~/nori_ws/docs/dev-interface.md` (the full control interface — topics, rates,
   safety).

**License.** The software on the unit is **source-available** under the
[PolyForm Internal Use License 1.0.0](https://polyformproject.org/licenses/internal-use/1.0.0):
you may use and modify it for your own internal work, but not redistribute it.

The rest of the page applies unchanged — in particular the [trust boundary](#trust-boundary)
(keep the robot on a network you control) and [support](#support-after-the-transition), which on
these units too exists only when you open a session.

## What you get to code against

- **The ros2_control graph at 50 Hz** — `/joint_states`, `JointJog` servo topics, the trajectory
  controllers, `/cmd_vel/*` through `twist_mux`, `/imu/data`, `/battery_state`, `/scan`, and
  camera topics.
- **The teleop arbiter, as an optional authority layer.** On a trusted LAN you may publish
  straight to the controllers and skip it. Both patterns will be documented.
- **A direct serial SDK** for the servo bus, with no ROS in the loop — the lowest-latency path.
  It bypasses the arbiter, the thermal monitor, and the supervisor, so it ships with an explicit
  **"you own safety here"** boundary.
- **A clean layer split.** A platform underlay (robot description, hardware plugins, controller
  config, safety and bringup) is managed by Nori as prebuilt, signed platform releases —
  notify-don't-apply, so nothing updates under you. Your code lives in an application overlay
  that sources it and is never touched by an update. Platform bringup comes up
  active-but-disarmed so your overlay connects to a live graph; taking bringup over entirely
  will be documented too.

## What stays on

Three gates protect the hardware from your own code:

- the **servo-resident 60 °C over-temperature cutoff** — enforced inside the servo itself,
  non-negotiable;
- the **driver-level whole-bus thermal lockout**;
- the **torque and comms watchdogs**.

Everything else becomes a documented, overridable parameter, and the docs will state exactly
where each fence is.

## What goes away

The backend-coupled stack is **absent, not broken**: no gateway, no dataset uploader, no agent.
That means no remote teleoperation through Nori's cloud, no recording upload, and no cloud
training or marketplace on that unit — your media and control never touch Nori's cloud. The rest
of this site describes the normal posture.

The serial number survives: it is asset identity (hardware, QC, warranty), not a credential.

## Trust boundary

On a dev unit, **the LAN is the trust boundary.** The arbiter arbitrates between clients but does
not authenticate them, and the open graph is reachable by any host on your network. Isolate the
robot's network accordingly.

## Support after the transition

No standing vendor path into a box you own. Tailscale is installed but **logged out
by default** — no key on disk, no tailnet membership, zero Nori reachability. Support is a
**consent-based session that you start and you end**:

**Start.** When you ask for support, Nori mints a one-time auth key limited to Nori's support group.
You are the one who runs it:

```bash
sudo tailscale up --authkey=<one-time-key> --advertise-tags=tag:dev-support --ssh
```

**During.** Nori can reach the box and, via Tailscale SSH scoped to the support group, get a shell
for the session. Watch it live with `tailscale status`.

**End.** `sudo tailscale down` takes the box off the tailnet (`sudo tailscale logout` also drops
the node key); the ephemeral key means the node vanishes from Nori's side on disconnect. You own
root, so you can also remove Tailscale entirely. Either way, the only path back is you running
`tailscale up` again with a fresh key — **there is no Nori-side action that opens or re-opens
access.**

Privacy-strict customers can skip this entirely: keep the unit on your own network or VPN and
invite us in per incident.
