"""Real-Time Chunking (RTC) for MolmoAct2 — inference-time, no retraining.

RTC (arXiv 2506.07339) removes the discontinuity you get when a freshly generated
action chunk replaces the one currently executing. It treats the overlap as an
INPAINTING problem during flow sampling: the actions that will inevitably execute
while we're computing are pinned to the previous chunk, a middle band is softly
guided toward it, and the tail beyond the old chunk is generated freely.

    idx <  d          "frozen"  weight 1      (executes during the inference delay)
    d <= idx < s      "guided"  weight 1->0   (EXP schedule)
    idx >= s          "free"    weight 0

Guidance is NOT an overwrite. Following the paper (and LeRobot's reference
implementation) it is a pseudoinverse-guidance (PiGDM) correction injected into the
velocity field at EVERY denoising step, via a vector-Jacobian product:

    x1     = x_t + (1 - tau) * v            # predicted clean sample
    err    = (prev_chunk - x1) * W          # weighted target error
    corr   = VJP(x1, x_t, err)              # d x1/d x_t ^T @ err
    v_rtc  = v + w(tau) * corr
    w(tau) = min(beta, ((1-tau)^2 + tau^2) / (tau * (1-tau)))

SIGN NOTE (the highest-risk part of this port): LeRobot integrates time 1->0 with a
velocity pointing toward NOISE and writes `v - w*corr`. MolmoAct2 integrates 0->1
with a velocity pointing toward DATA (`trajectory = trajectory + dt * velocity`), so
the correction ADDS here. Both end up moving the trajectory by +corr; only the
velocity convention differs. `selftest_guidance_direction()` asserts this
empirically rather than trusting the derivation.

COSTS (measured/reported, worth knowing before enabling):
  * needs autograd -> the model's @torch.no_grad() must be lifted, and the
    CUDA-graph fast path must be disabled (you cannot backprop a captured graph).
  * ~20% extra latency on top of that. We are already NETWORK-bound, so RTC is
    only worth enabling once the round-trip is short.
  * requires d <= s <= H - d. With H=30, s=10: d <= 10. At 10fps that's ~1.0s of
    tolerable delay; at 15fps only ~0.66s.
"""

import math
from typing import Optional

import torch


def prefix_weights(
    delay: int, execution_horizon: int, total: int, schedule: str = "exp"
) -> torch.Tensor:
    """Per-timestep guidance weights (port of LeRobot's get_prefix_weights).

    `delay` (d) actions are pinned at 1.0; weights decay to 0 by `execution_horizon`
    (s); everything at/after s is free (0.0)."""
    start = min(delay, execution_horizon)
    end = execution_horizon
    if schedule == "zeros":
        w = torch.zeros(total)
        w[:start] = 1.0
        return w
    if schedule == "ones":
        w = torch.ones(total)
        w[end:] = 0.0
        return w

    # linear ramp over the guided band, exclusive of the 1.0 and 0.0 endpoints
    skip = max(total - end, 0)
    steps = total - skip - start
    lin = torch.linspace(1, 0, steps + 2)[1:-1] if (end > start and steps > 0) else torch.tensor([])
    if schedule == "exp":
        # decay harder than linear: w * expm1(w) / (e - 1)
        lin = lin * torch.expm1(lin).div(math.e - 1)
    if total - end > 0:
        lin = torch.cat([lin, torch.zeros(total - end)])
    if min(start, total) > 0:
        lin = torch.cat([torch.ones(min(start, total)), lin])
    return lin


def guidance_weight(tau: float, max_weight: float) -> float:
    """w(tau) = min(beta, ((1-tau)^2 + tau^2) / (tau*(1-tau))), clamped at both ends."""
    one_minus = 1.0 - tau
    if tau <= 0.0 or one_minus <= 0.0:
        return float(max_weight)
    w = ((one_minus ** 2) + (tau ** 2)) / (tau * one_minus)
    return float(min(w, max_weight))


def feasible(delay: int, horizon: int, execution_horizon: int) -> bool:
    """RTC needs d <= s <= H - d. Past that the frozen prefix and the free tail
    overlap and the guidance is not well defined — better to skip RTC for that
    request than to emit a silently wrong chunk."""
    return 0 <= delay <= execution_horizon <= horizon - delay


def pick_execution_horizon(delay: int, horizon: int) -> Optional[int]:
    """Smallest feasible s that leaves the guided band some room, or None if the
    delay is too large for this horizon (d > H/2)."""
    s = min(max(delay + 4, delay), horizon - delay)
    return s if feasible(delay, horizon, s) else None


class RTCState:
    """Per-session guidance target, kept in the model's NORMALIZED action space.

    We cache the previous chunk as the raw flow output rather than asking the client
    to send actions back: the flow operates on normalized actions, so a robot-scale
    chunk from the client would have to be re-normalized (and our client also applies
    a joint calibration). Caching the model's own output sidesteps both."""

    def __init__(self) -> None:
        self.prev: Optional[torch.Tensor] = None  # (B, H, A) normalized
        self.enabled = False
        self.consumed = 0        # actions executed since `prev` was produced (= alignment shift)
        self.delay = 0           # d: actions that will execute during THIS inference
        self.execution_horizon = 10
        self.max_guidance_weight = 10.0
        self.schedule = "exp"
        self.applied = 0         # count of guided steps, for observability

    def target(self, like: torch.Tensor) -> Optional[torch.Tensor]:
        """Previous chunk aligned to the new chunk's timeline: drop the `consumed`
        actions that already executed, then zero-pad to the new chunk's shape."""
        if not self.enabled or self.prev is None:
            return None
        left = self.prev[:, self.consumed:, :]
        if left.shape[1] == 0:
            return None
        out = torch.zeros_like(like)
        n = min(left.shape[1], out.shape[1])
        a = min(left.shape[2], out.shape[2])
        out[:, :n, :a] = left[:, :n, :a].to(out.device, out.dtype)
        return out


def _flow_owner(model):
    """Find the object that actually owns the flow loop.

    `_run_action_flow_loop`, `_require_action_expert` and `_mask_action_dim_tensor`
    are all methods of MolmoAct2Model, while what you load from the Hub is a
    MolmoAct2ForConditionalGeneration that HOLDS one as `.model`. Patching the
    outer wrapper raises AttributeError at load time and takes the whole server
    down, so resolve the owner instead of assuming it."""
    for cand in (model, getattr(model, "model", None), getattr(model, "base_model", None)):
        if cand is not None and hasattr(cand, "_run_action_flow_loop"):
            return cand
    return None


def install_rtc(model, state: RTCState):
    """Monkeypatch the flow loop to apply RTC guidance.

    Returns the original bound method, or None if the loop could not be located —
    NEVER raises. A diagnostic feature must not be able to stop the model from
    loading; without the patch the server simply serves un-guided chunks.

    The patched loop is a no-op (bit-identical to upstream) whenever `state` has no
    target, so leaving it installed costs nothing when RTC is off."""
    owner = _flow_owner(model)
    if owner is None:
        return None
    original = owner._run_action_flow_loop

    def guided_loop(inputs, steps: int) -> torch.Tensor:
        trajectory = inputs.trajectory
        target = state.target(trajectory)
        if target is None:
            # No usable prefix (first call of a session, or the previous chunk is
            # fully consumed). Run upstream verbatim — but still CAPTURE the output,
            # or the next call has nothing to guide toward.
            out = original(inputs, steps)
            state.prev = out.detach()
            return out

        action_expert = owner._require_action_expert()
        dt = 1.0 / steps
        pad = inputs.action_dim_is_pad
        mask_enabled = owner.config.mask_action_dim_padding
        W = prefix_weights(state.delay, state.execution_horizon,
                           trajectory.shape[1], state.schedule)
        W = W.to(trajectory.device, trajectory.dtype).view(1, -1, 1)

        for idx in range(steps):
            tau = idx / steps  # 0 = noise, 1 = data (MolmoAct2 integrates forward)
            x_t = trajectory.detach().requires_grad_(True)
            with torch.enable_grad():
                velocity = action_expert.forward_with_context(
                    x_t,
                    inputs.modulations[idx].conditioning,
                    context=inputs.context,
                    modulation=inputs.modulations[idx],
                )
                velocity = owner._mask_action_dim_tensor(
                    velocity, action_dim_is_pad=pad, enabled=mask_enabled
                )
                x1 = x_t + (1.0 - tau) * velocity          # predicted clean sample
                err = ((target - x1) * W).detach()          # weighted pull toward prev
                corr = torch.autograd.grad(x1, x_t, err, retain_graph=False)[0]

            w = guidance_weight(tau, state.max_guidance_weight)
            # + (not -): our velocity points toward DATA -- see SIGN NOTE above.
            velocity = (velocity + w * corr).detach()
            trajectory = owner._mask_action_dim_tensor(
                trajectory.detach() + dt * velocity, action_dim_is_pad=pad, enabled=mask_enabled
            )
            state.applied += 1
        state.prev = trajectory.detach()
        return trajectory

    owner._run_action_flow_loop = guided_loop
    return original


# --------------------------------------------------------------------------- tests
def selftest_guidance_direction() -> dict:
    """Assert the SIGN empirically on a toy linear flow, with no model involved.

    Toy: velocity = (goal - x). Euler-integrating it drives x -> goal. With RTC
    guidance toward `prev`, the FROZEN prefix must end up closer to `prev` than the
    unguided run does, and the free tail must be left alone."""
    H, A, steps = 30, 4, 10
    goal = torch.zeros(1, H, A)
    prev = torch.ones(1, H, A) * 5.0
    W = prefix_weights(4, 10, H, "exp").view(1, -1, 1)

    def run(guided: bool) -> torch.Tensor:
        x = torch.full((1, H, A), -5.0)
        for idx in range(steps):
            tau = idx / steps
            xt = x.detach().requires_grad_(True)
            with torch.enable_grad():
                v = goal - xt
                x1 = xt + (1.0 - tau) * v
                if guided:
                    err = ((prev - x1) * W).detach()
                    corr = torch.autograd.grad(x1, xt, err, retain_graph=False)[0]
                    v = v + guidance_weight(tau, 10.0) * corr
            x = (x.detach() + (1.0 / steps) * v.detach())
        return x

    plain, rtc = run(False), run(True)
    d_plain = (plain[0, 0] - prev[0, 0]).abs().mean().item()
    d_rtc = (rtc[0, 0] - prev[0, 0]).abs().mean().item()
    tail_shift = (rtc[0, -1] - plain[0, -1]).abs().mean().item()
    return {
        "prefix_dist_unguided": round(d_plain, 4),
        "prefix_dist_rtc": round(d_rtc, 4),
        "prefix_pulled_toward_prev": d_rtc < d_plain,
        "free_tail_unchanged": tail_shift < 1e-5,
    }


if __name__ == "__main__":
    w = prefix_weights(4, 10, 30, "exp")
    print("weights[:12]:", [round(float(x), 3) for x in w[:12]])
    print("frozen prefix all 1.0 :", bool((w[:4] == 1.0).all()))
    print("free tail all 0.0     :", bool((w[10:] == 0.0).all()))
    print("monotonic in guided band:", bool((w[4:10].diff() <= 0).all()))
    print("w(tau) mid/edges      :", [round(guidance_weight(t, 10.0), 3) for t in (0.0, 0.1, 0.5, 0.9, 1.0)])
    print("direction selftest    :", selftest_guidance_direction())
