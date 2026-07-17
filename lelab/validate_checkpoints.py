"""Offline checkpoint-selection / validation pipeline.

Given a set of training CHECKPOINTS (of the same policy) and a held-out
validation LeRobotDataset, this computes each checkpoint's validation loss and
picks the best one. The only "hyperparameter" swept is the checkpoint (step).

Why this exists: lerobot ships NO offline dataset-loss evaluator — its
`lerobot-eval` is gym-env rollout only, and training never runs env-eval in our
cloud path (`eval_freq=0`). Selecting a checkpoint by *training* loss overfits
(loss keeps dropping while the policy memorizes); the honest signal is the same
loss measured on data the model never trained on.

Correctness: we reproduce lerobot's OWN per-batch training-loss path
(`scripts/lerobot_train.py:457-475`) exactly, rather than hand-rolling it:

    for cam in dataset.meta.camera_keys:            # uint8 -> float/255
        batch[cam] = batch[cam].float() / 255.0
    batch = preprocessor(batch)                     # normalization lives HERE
    loss, out = policy.forward(batch)               # returns (scalar, dict|None)

The normalization stats are NOT baked into the policy weights in lerobot 0.5.2
(the processor-pipeline era) — they live in the checkpoint's
`policy_preprocessor*.safetensors`. We restore them via `make_pre_post_processors(
cfg, pretrained_path=...)`, which is more faithful than recomputing stats from
the val set (that would diverge under use_imagenet_stats / quantile norm).

The `device_processor` override is load-bearing: the fitted processors bake in
the *training* device ("cuda"); on a non-CUDA host that step fails to
instantiate and lerobot silently falls back to config-default processors, which
DROP the fitted stats -> the policy sees un-normalized obs and every checkpoint
scores as garbage. (Mirrors the 2026-07-15 mps incident fix in nori_rollout.py.)

Metric: `policy.forward` returns `(loss, output_dict)`.
  * ACT      -> output_dict = {"l1_loss", "kld_loss"?}. We SELECT on the masked
               `l1_loss` (action-prediction error, the behavioral signal); the
               VAE `kld_loss` is a latent regularizer, reported but not selected.
  * Diffusion-> output_dict is None and the loss is STOCHASTIC (random noise +
               timestep per call). We fix a per-batch seed and average
               `--diffusion-passes` forwards so checkpoints are compared on the
               same noise draws.
  * fallback -> the scalar total loss.
Lower is better.

CAVEAT (printed with the results): offline behavioral-cloning loss is a *proxy*
for on-robot success. Compounding errors mean the argmin-loss checkpoint is not
guaranteed to roll out best. Treat the curve, not just the winner, as the
output and cross-check the pick against an on-robot ID/OOD eval.

Usage:
    python -m lelab.validate_checkpoints \
        --checkpoints outputs/train/act_cup/checkpoints \
        --dataset  ${HF_USER}/cup_val            # repo_id OR local dataset dir
        [--val-episodes 0,3,7]                   # subset; default = all episodes
        [--diffusion-passes 3] [--batch-size 8] [--device auto]
        [--report out/val_report.json] [--list-only]
"""

from __future__ import annotations

import argparse
import json
import logging
from dataclasses import dataclass, asdict, field
from pathlib import Path

logger = logging.getLogger("lelab.validate_checkpoints")

# lerobot's canonical checkpoint sub-dir name (utils/constants.PRETRAINED_MODEL_DIR)
PRETRAINED_MODEL_DIR = "pretrained_model"
MODEL_FILE = "model.safetensors"


# --------------------------------------------------------------------------- #
# Checkpoint discovery                                                         #
# --------------------------------------------------------------------------- #
def _is_pretrained_dir(p: Path) -> bool:
    """A `pretrained_model/`-style dir: holds the weights directly."""
    return (p / MODEL_FILE).is_file()


def discover_checkpoints(paths: list[str]) -> list[tuple[int, Path]]:
    """Resolve input path(s) into an ordered list of (step, pretrained_model_dir).

    Accepts, for each path:
      * a `pretrained_model/` dir (contains model.safetensors)          -> 1 ckpt
      * a step dir `005000/` (contains pretrained_model/model.safetensors)
      * a `checkpoints/` dir of numeric step dirs                       -> N ckpts
      * a train output dir containing `checkpoints/`                    -> recurse

    `step` is parsed from the numeric dir name when present, else -1. lerobot's
    `last` symlink is skipped (it duplicates the newest numeric dir).
    """
    found: dict[Path, int] = {}

    def add(step: int, pm_dir: Path):
        pm_dir = pm_dir.resolve()
        if pm_dir not in found:
            found[pm_dir] = step

    def handle(p: Path):
        p = Path(p)
        if not p.exists():
            raise FileNotFoundError(f"checkpoint path does not exist: {p}")
        # a checkpoints/ container may be nested one level down (train output dir)
        if p.is_dir() and (p / "checkpoints").is_dir() and not _is_pretrained_dir(p):
            p = p / "checkpoints"
        # direct pretrained_model dir
        if _is_pretrained_dir(p):
            step = _parse_step(p.parent.name)  # .../<step>/pretrained_model
            add(step, p)
            return
        # step dir holding pretrained_model/
        if (p / PRETRAINED_MODEL_DIR / MODEL_FILE).is_file():
            add(_parse_step(p.name), p / PRETRAINED_MODEL_DIR)
            return
        # a container of numeric step dirs (the `checkpoints/` dir); zero-padded
        # names like 0005000 are fine — require the name to be all digits and
        # skip lerobot's `last` symlink (it duplicates the newest numeric dir)
        step_dirs = [d for d in sorted(p.iterdir())
                     if d.is_dir() and not d.is_symlink() and d.name.isdigit()]
        hits = 0
        for d in step_dirs:
            pm = d / PRETRAINED_MODEL_DIR
            if _is_pretrained_dir(pm):
                add(_parse_step(d.name), pm)
                hits += 1
        if hits == 0:
            raise FileNotFoundError(
                f"no checkpoints found under {p} "
                f"(looked for */{PRETRAINED_MODEL_DIR}/{MODEL_FILE})"
            )

    for path in paths:
        handle(path)

    return sorted(((step, d) for d, step in found.items()), key=lambda t: (t[0], str(t[1])))


def _parse_step(name: str) -> int:
    return int(name) if name.isdigit() else -1


# --------------------------------------------------------------------------- #
# Device                                                                       #
# --------------------------------------------------------------------------- #
def _resolve_device(requested: str) -> str:
    import torch

    if requested and requested != "auto":
        return requested
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


# --------------------------------------------------------------------------- #
# Policy + processor loading (mirrors nori_rollout._load_bundle essentials)    #
# --------------------------------------------------------------------------- #
def _load_policy_and_pre(bundle: Path, device: str):
    """Load a checkpoint's policy + input preprocessor with fitted stats.

    Returns (policy, preprocessor, cfg). Reuses the MPS device-override so the
    fitted normalization stats actually load on non-CUDA hosts.
    """
    from lerobot.configs.policies import PreTrainedConfig
    from lerobot.policies.factory import get_policy_class, make_pre_post_processors

    cfg = PreTrainedConfig.from_pretrained(str(bundle))
    policy_cls = get_policy_class(cfg.type)
    policy = policy_cls.from_pretrained(str(bundle), config=cfg)
    policy.to(device)
    policy.eval()

    dev_override = {"device_processor": {"device": device}}
    try:
        pre, _post = make_pre_post_processors(
            cfg,
            pretrained_path=str(bundle),
            preprocessor_overrides=dev_override,
            postprocessor_overrides=dev_override,
        )
    except Exception as e:  # noqa: BLE001 — mirror rollout's defensive fallback
        # No fitted processors -> stats would be missing; this is a correctness
        # failure for validation (un-normalized obs), so surface it loudly
        # rather than silently scoring garbage.
        raise RuntimeError(
            f"could not load fitted processors from {bundle} ({e}); "
            "validation loss would be computed on un-normalized observations"
        ) from e
    return policy, pre, cfg


# --------------------------------------------------------------------------- #
# Dataset                                                                      #
# --------------------------------------------------------------------------- #
def _build_val_dataset(dataset: str, cfg, episodes: list[int] | None, tolerance_s: float):
    """Construct a LeRobotDataset matching how training loaded it.

    `dataset` may be an HF repo_id ("org/name") or a local dataset directory
    (one containing meta/info.json). delta_timestamps are resolved from the
    policy config so ACT gets its action chunk (+action_is_pad) and diffusion
    its obs/action horizons — identical to make_dataset().
    """
    from lerobot.datasets.dataset_metadata import LeRobotDatasetMetadata
    from lerobot.datasets.lerobot_dataset import LeRobotDataset
    from lerobot.datasets.factory import resolve_delta_timestamps

    repo_id, root = _resolve_dataset_location(dataset)
    ds_meta = LeRobotDatasetMetadata(repo_id, root=root)
    delta_timestamps = resolve_delta_timestamps(cfg, ds_meta)

    ds = LeRobotDataset(
        repo_id,
        root=root,
        episodes=episodes,
        delta_timestamps=delta_timestamps,
        tolerance_s=tolerance_s,
        return_uint8=True,  # cams as uint8 -> we /255 before the preprocessor
    )
    return ds


def _resolve_dataset_location(dataset: str) -> tuple[str, str | None]:
    """Return (repo_id, root). Local dir -> (dir-name, dir); repo_id -> (id, None).

    A local path is any existing dir with meta/info.json. For a bare repo_id we
    let LeRobotDataset fetch it (it snapshot_downloads to the HF cache).
    """
    p = Path(dataset).expanduser()
    if p.exists() and (p / "meta" / "info.json").is_file():
        return p.name, str(p)
    if p.exists() and p.is_dir():
        raise FileNotFoundError(
            f"{p} exists but is not a LeRobotDataset (no meta/info.json)"
        )
    # treat as a hub repo_id
    return dataset, None


# --------------------------------------------------------------------------- #
# Evaluation                                                                   #
# --------------------------------------------------------------------------- #
@dataclass
class CheckpointResult:
    step: int
    path: str
    n_samples: int
    total_loss: float
    l1_loss: float | None = None
    kld_loss: float | None = None
    primary: float = field(default=0.0)  # the value selected on (lower=better)
    error: str | None = None


def _evaluate_checkpoint(
    bundle: Path,
    step: int,
    dataset,
    device: str,
    batch_size: int,
    num_workers: int,
    diffusion_passes: int,
    seed: int,
) -> CheckpointResult:
    import torch
    from torch.utils.data import DataLoader

    policy, pre, cfg = _load_policy_and_pre(bundle, device)
    is_diffusion = getattr(cfg, "type", "") == "diffusion"
    camera_keys = list(dataset.meta.camera_keys)

    loader = DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=False,
        num_workers=num_workers,
        drop_last=False,
    )

    tot_loss = 0.0
    tot_l1 = 0.0
    tot_kld = 0.0
    has_l1 = False
    has_kld = False
    n = 0

    with torch.no_grad():
        for b_idx, batch in enumerate(loader):
            # uint8 cameras -> float/255, exactly as the train loop does upstream
            for cam in camera_keys:
                if cam in batch and batch[cam].dtype == torch.uint8:
                    batch[cam] = batch[cam].to(dtype=torch.float32) / 255.0
            batch = pre(batch)  # normalization + device move happen here
            bs = _batch_size_of(batch)

            if is_diffusion:
                # stochastic loss: average N seeded passes on the same batch so
                # every checkpoint sees identical noise/timestep draws
                acc = 0.0
                for k in range(diffusion_passes):
                    torch.manual_seed(seed + b_idx * 100003 + k)
                    loss, _ = policy.forward(batch)
                    acc += float(loss.item())
                loss_val = acc / max(1, diffusion_passes)
                tot_loss += loss_val * bs
            else:
                loss, out = policy.forward(batch)
                tot_loss += float(loss.item()) * bs
                if isinstance(out, dict):
                    if "l1_loss" in out:
                        has_l1 = True
                        tot_l1 += float(out["l1_loss"]) * bs
                    if "kld_loss" in out:
                        has_kld = True
                        tot_kld += float(out["kld_loss"]) * bs
            n += bs

    if n == 0:
        return CheckpointResult(step, str(bundle), 0, float("nan"),
                                error="validation dataset produced 0 samples")

    mean_total = tot_loss / n
    mean_l1 = (tot_l1 / n) if has_l1 else None
    mean_kld = (tot_kld / n) if has_kld else None
    # select on the behavioral term (ACT l1) when available, else total loss
    primary = mean_l1 if mean_l1 is not None else mean_total
    return CheckpointResult(
        step=step, path=str(bundle), n_samples=n,
        total_loss=mean_total, l1_loss=mean_l1, kld_loss=mean_kld,
        primary=primary,
    )


def _batch_size_of(batch: dict) -> int:
    import torch

    for v in batch.values():
        if isinstance(v, torch.Tensor) and v.dim() >= 1:
            return int(v.shape[0])
    return 1


# --------------------------------------------------------------------------- #
# Orchestration                                                                #
# --------------------------------------------------------------------------- #
@dataclass
class ValidationReport:
    dataset: str
    device: str
    val_episodes: list[int] | None
    metric: str
    best_step: int
    best_path: str
    results: list[dict]
    caveat: str = (
        "Offline behavioral-cloning loss is a PROXY for on-robot success. "
        "The argmin-loss checkpoint is not guaranteed to roll out best "
        "(compounding errors). Cross-check the pick against an on-robot ID/OOD eval."
    )


def validate_checkpoints(
    checkpoints: list[str],
    dataset: str,
    val_episodes: list[int] | None = None,
    device: str = "auto",
    batch_size: int = 8,
    num_workers: int = 0,
    diffusion_passes: int = 3,
    tolerance_s: float = 1e-4,
    seed: int = 42,
) -> ValidationReport:
    """Evaluate every checkpoint on the validation dataset; return a ranked report."""
    ckpts = discover_checkpoints(checkpoints)
    if not ckpts:
        raise FileNotFoundError("no checkpoints discovered")
    device = _resolve_device(device)
    logger.info("device=%s | %d checkpoint(s) | dataset=%s", device, len(ckpts), dataset)

    # Build the val dataset ONCE from the first checkpoint's config. All
    # checkpoints of one run share the same policy config (delta indices), so
    # the delta_timestamps are identical; we assert this per checkpoint below.
    from lerobot.configs.policies import PreTrainedConfig

    first_cfg = PreTrainedConfig.from_pretrained(str(ckpts[0][1]))
    ds = _build_val_dataset(dataset, first_cfg, val_episodes, tolerance_s)
    logger.info("val dataset: %d frames across %d episode(s)",
                ds.num_frames, ds.num_episodes)

    results: list[CheckpointResult] = []
    for step, bundle in ckpts:
        logger.info("evaluating step=%s (%s)", step, bundle)
        try:
            res = _evaluate_checkpoint(
                bundle, step, ds, device, batch_size, num_workers,
                diffusion_passes, seed,
            )
        except Exception as e:  # noqa: BLE001 — one bad ckpt shouldn't sink the sweep
            logger.exception("checkpoint step=%s failed", step)
            res = CheckpointResult(step, str(bundle), 0, float("nan"), error=str(e))
        results.append(res)

    ok = [r for r in results if r.error is None]
    if not ok:
        raise RuntimeError("all checkpoints failed to evaluate; see logs")
    best = min(ok, key=lambda r: r.primary)
    metric = "l1_loss (masked action error)" if best.l1_loss is not None else "total_loss"

    return ValidationReport(
        dataset=dataset,
        device=device,
        val_episodes=val_episodes,
        metric=metric,
        best_step=best.step,
        best_path=best.path,
        results=[asdict(r) for r in results],
    )


# --------------------------------------------------------------------------- #
# CLI                                                                          #
# --------------------------------------------------------------------------- #
def _print_table(report: ValidationReport):
    print(f"\nValidation over: {report.dataset}")
    print(f"Device: {report.device}  |  Selection metric: {report.metric}")
    if report.val_episodes is not None:
        print(f"Val episodes: {report.val_episodes}")
    print("-" * 72)
    print(f"{'step':>8}  {'samples':>8}  {'total':>10}  {'l1':>10}  {'kld':>10}")
    print("-" * 72)
    for r in report.results:
        star = "  *BEST" if (r["step"] == report.best_step and r["error"] is None) else ""
        if r["error"]:
            print(f"{r['step']:>8}  {'-':>8}  {'ERROR':>10}  {'':>10}  {'':>10}  {r['error'][:40]}")
            continue
        l1 = f"{r['l1_loss']:.5f}" if r["l1_loss"] is not None else "—"
        kld = f"{r['kld_loss']:.5f}" if r["kld_loss"] is not None else "—"
        print(f"{r['step']:>8}  {r['n_samples']:>8}  {r['total_loss']:>10.5f}  "
              f"{l1:>10}  {kld:>10}{star}")
    print("-" * 72)
    print(f"BEST checkpoint: step {report.best_step}")
    print(f"  -> {report.best_path}")
    print(f"\nNOTE: {report.caveat}\n")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Select the best training checkpoint by validation loss on a held-out dataset.",
    )
    ap.add_argument("--checkpoints", nargs="+", required=True,
                    help="checkpoint path(s): a checkpoints/ dir, a train output dir, "
                         "a <step>/ dir, or a pretrained_model/ dir")
    ap.add_argument("--dataset", required=True,
                    help="validation dataset: HF repo_id (org/name) or a local "
                         "LeRobotDataset dir (with meta/info.json)")
    ap.add_argument("--val-episodes", default=None,
                    help="comma-separated episode indices to use as validation "
                         "(default: all episodes in the dataset)")
    ap.add_argument("--device", default="auto", help="auto|mps|cuda|cpu")
    ap.add_argument("--batch-size", type=int, default=8)
    ap.add_argument("--num-workers", type=int, default=0)
    ap.add_argument("--diffusion-passes", type=int, default=3,
                    help="averaged forward passes for stochastic diffusion loss")
    ap.add_argument("--tolerance-s", type=float, default=1e-4,
                    help="timestamp sync tolerance (matches training default)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--report", default=None, help="write the JSON report to this path")
    ap.add_argument("--list-only", action="store_true",
                    help="just list discovered checkpoints and exit (no loading)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )

    if args.list_only:
        for step, d in discover_checkpoints(args.checkpoints):
            print(f"step={step:>8}  {d}")
        return 0

    val_eps = (
        [int(x) for x in args.val_episodes.split(",") if x.strip() != ""]
        if args.val_episodes else None
    )

    report = validate_checkpoints(
        checkpoints=args.checkpoints,
        dataset=args.dataset,
        val_episodes=val_eps,
        device=args.device,
        batch_size=args.batch_size,
        num_workers=args.num_workers,
        diffusion_passes=args.diffusion_passes,
        tolerance_s=args.tolerance_s,
        seed=args.seed,
    )
    _print_table(report)

    if args.report:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(json.dumps(asdict(report), indent=2))
        print(f"report written: {args.report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
