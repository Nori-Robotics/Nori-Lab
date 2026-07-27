"""Unit tests for the Patch Policy reimplementation.

All tests use the fake encoder (no network, no pretrained weights) and a tiny
config so they run on CPU in seconds. The causality test is the load-bearing
one: it proves the block-causal mask does what the paper specifies.
"""

from __future__ import annotations

import sys
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from patch_policy.model import PatchPolicy, PatchPolicyConfig, block_causal_mask  # noqa: E402


def tiny_config(**overrides) -> PatchPolicyConfig:
    defaults = dict(
        action_dim=12,
        cameras=("front", "wrist"),
        obs_window=2,
        chunk_size=5,
        image_size=32,
        patches_per_image=16,   # 4x4 grid
        encoder_dim=24,
        encoder="fake",
        embed_dim=24,
        depth=2,
        heads=2,
    )
    defaults.update(overrides)
    return PatchPolicyConfig(**defaults)


def fake_obs(cfg: PatchPolicyConfig, batch: int = 2, seed: int = 0) -> dict[str, torch.Tensor]:
    g = torch.Generator().manual_seed(seed)
    return {
        cam: torch.rand(batch, cfg.obs_window, 3, cfg.image_size, cfg.image_size, generator=g)
        for cam in cfg.cameras
    }


def test_block_causal_mask_shape_and_semantics() -> None:
    mask = block_causal_mask(num_frames=3, patches_per_frame=4)
    assert mask.shape == (12, 12)
    # Within-frame: bidirectional (frame 1 spans tokens 4..7).
    assert mask[4, 7] and mask[7, 4]
    # Across frames: later attends earlier, never the reverse.
    assert mask[8, 3] and not mask[3, 8]
    # Frame 0 attends only to itself.
    assert mask[0, :4].all() and not mask[0, 4:].any()


def test_forward_shapes_and_param_count() -> None:
    cfg = tiny_config()
    policy = PatchPolicy(cfg)
    out = policy.forward(fake_obs(cfg))
    assert out.shape == (2, cfg.obs_window, cfg.chunk_size, cfg.action_dim)
    # The frozen encoder contributes no trainable parameters.
    assert all(not n.startswith("encoder.") for n, p in policy.named_parameters() if p.requires_grad)


def test_future_frames_cannot_influence_earlier_readouts() -> None:
    """Perturbing the LAST frame's images must not change the FIRST frame's
    predicted chunk — the definition of block-causal attention."""
    cfg = tiny_config(obs_window=3)
    policy = PatchPolicy(cfg).eval()
    obs_a = fake_obs(cfg, batch=1, seed=1)
    obs_b = {cam: t.clone() for cam, t in obs_a.items()}
    for cam in cfg.cameras:  # scramble only the final frame
        obs_b[cam][:, -1] = torch.rand_like(obs_b[cam][:, -1])
    with torch.no_grad():
        out_a = policy.forward(obs_a)
        out_b = policy.forward(obs_b)
    torch.testing.assert_close(out_a[:, 0], out_b[:, 0], atol=1e-5, rtol=1e-4)
    torch.testing.assert_close(out_a[:, 1], out_b[:, 1], atol=1e-5, rtol=1e-4)
    assert not torch.allclose(out_a[:, -1], out_b[:, -1], atol=1e-3)


def test_loss_respects_padding_mask() -> None:
    cfg = tiny_config()
    policy = PatchPolicy(cfg)
    obs = fake_obs(cfg)
    actions = torch.randn(2, cfg.obs_window, cfg.chunk_size, cfg.action_dim)
    no_pad = torch.zeros(2, cfg.obs_window, cfg.chunk_size, dtype=torch.bool)
    all_but_one_pad = torch.ones_like(no_pad)
    all_but_one_pad[0, 0, 0] = False
    loss_full = policy.loss(obs, actions, no_pad)
    loss_masked = policy.loss(obs, actions, all_but_one_pad)
    assert loss_full.item() > 0
    # Fully-padded steps drop out; masked loss equals the single kept step's error.
    pred = policy.forward(obs)
    target = (actions - policy.act_mean) / policy.act_std
    expected = (pred - target).abs()[0, 0, 0].mean()
    torch.testing.assert_close(loss_masked, expected, atol=1e-5, rtol=1e-4)


def test_act_denormalizes_with_dataset_stats() -> None:
    mean, std = [2.0] * 12, [4.0] * 12
    cfg = tiny_config(action_mean=tuple(mean), action_std=tuple(std))
    policy = PatchPolicy(cfg).eval()
    obs = fake_obs(cfg, batch=1)
    with torch.no_grad():
        normalized = policy.forward(obs)[0, -1]
    chunk = policy.act(obs)
    assert chunk.shape == (cfg.chunk_size, cfg.action_dim)
    torch.testing.assert_close(chunk, normalized * 4.0 + 2.0, atol=1e-5, rtol=1e-4)


def test_gradients_flow_to_policy_not_encoder() -> None:
    cfg = tiny_config()
    policy = PatchPolicy(cfg)
    actions = torch.randn(2, cfg.obs_window, cfg.chunk_size, cfg.action_dim)
    loss = policy.loss(fake_obs(cfg), actions)
    loss.backward()
    assert policy.pos_embed.grad is not None
    head_weight = policy.action_head[0].weight
    assert head_weight.grad is not None and head_weight.grad.abs().sum() > 0
