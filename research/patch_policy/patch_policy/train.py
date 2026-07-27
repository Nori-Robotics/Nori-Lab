"""Behavior-cloning trainer for Patch Policy on a LeRobot dataset.

Example (paper's real-world recipe — T=2, chunk 5, batch 128, lr 3e-4, wd 1e-4):

    python -m patch_policy.train \
        --repo-id nori/move_red_cup_final --cameras front wrist_left wrist_right \
        --steps 20000 --batch 128 --out runs/move_red_cup

Run from research/patch_policy/. On a Mac use --batch 16 --device mps to smoke
the pipeline; real training targets 1x L40S (paper: ~6.5 GPU-hours).
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import time
from pathlib import Path

import torch
from torch.utils.data import DataLoader

from .data import PatchPolicyDataset
from .model import PatchPolicy, PatchPolicyConfig


def pick_device(name: str) -> torch.device:
    if name != "auto":
        return torch.device(name)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Train Patch Policy (BC)")
    parser.add_argument("--repo-id", required=True)
    parser.add_argument("--root", default=None, help="local dataset root override")
    parser.add_argument("--cameras", nargs="+", required=True)
    parser.add_argument("--obs-window", type=int, default=2)
    parser.add_argument("--chunk", type=int, default=5)
    parser.add_argument("--steps", type=int, default=20_000)
    parser.add_argument("--batch", type=int, default=128)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--encoder", default="dinov2_vits14")
    parser.add_argument("--log-every", type=int, default=50)
    parser.add_argument("--save-every", type=int, default=2_000)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)

    device = pick_device(args.device)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    # Probe the dataset for action_dim before building the model.
    probe_cfg = PatchPolicyConfig(
        action_dim=1, cameras=tuple(args.cameras),
        obs_window=args.obs_window, chunk_size=args.chunk, encoder=args.encoder,
    )
    dataset = PatchPolicyDataset(probe_cfg, args.repo_id, root=args.root)
    mean, std = dataset.action_stats()
    cfg = dataclasses.replace(
        probe_cfg, action_dim=len(mean), action_mean=tuple(mean), action_std=tuple(std)
    )
    dataset.cfg = cfg

    policy = PatchPolicy(cfg).to(device)
    trainable = sum(p.numel() for p in policy.trainable_parameters())
    print(f"device={device} trainable_params={trainable/1e6:.1f}M action_dim={cfg.action_dim}")

    loader = DataLoader(
        dataset, batch_size=args.batch, shuffle=True, drop_last=True,
        num_workers=args.workers, pin_memory=device.type == "cuda", persistent_workers=args.workers > 0,
    )
    optim = torch.optim.AdamW(
        policy.trainable_parameters(), lr=args.lr, weight_decay=args.weight_decay
    )
    scaler = torch.amp.GradScaler(enabled=device.type == "cuda")

    def save(step: int) -> None:
        torch.save(
            {"config": dataclasses.asdict(cfg), "state_dict": policy.state_dict(), "step": step},
            out / f"checkpoint_{step:07d}.pt",
        )
        (out / "config.json").write_text(json.dumps(dataclasses.asdict(cfg), indent=2))

    step, t0, running = 0, time.time(), 0.0
    policy.train()
    while step < args.steps:
        for batch in loader:
            images = {c: batch["images"][c].to(device, non_blocking=True) for c in cfg.cameras}
            actions = batch["actions"].to(device, non_blocking=True)
            pad = batch["pad"].to(device, non_blocking=True)
            with torch.autocast(device.type, enabled=device.type == "cuda"):
                loss = policy.loss(images, actions, pad)
            optim.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.step(optim)
            scaler.update()
            running += loss.item()
            step += 1
            if step % args.log_every == 0:
                rate = args.log_every / (time.time() - t0)
                print(f"step {step}/{args.steps} loss {running/args.log_every:.4f} ({rate:.1f} it/s)")
                running, t0 = 0.0, time.time()
            if step % args.save_every == 0 or step == args.steps:
                save(step)
            if step >= args.steps:
                break
    print(f"done — checkpoints in {out}")


if __name__ == "__main__":
    main()
