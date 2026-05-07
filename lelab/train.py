"""Training-specific helpers: the request schema and the LeRobot CLI builder.

The actual job lifecycle (subprocess management, registry, log streaming)
lives in app/jobs.py.
"""

import re
from typing import List, Optional

from pydantic import BaseModel


_SLUG_RE = re.compile(r"[^a-zA-Z0-9._-]+")



class TrainingRequest(BaseModel):
    # Dataset configuration
    dataset_repo_id: str
    dataset_revision: Optional[str] = None
    dataset_root: Optional[str] = None
    dataset_episodes: Optional[List[int]] = None

    # Policy configuration
    policy_type: str = "act"

    # Core training parameters
    steps: int = 10000
    batch_size: int = 8
    seed: Optional[int] = 1000
    num_workers: int = 4

    # Logging and checkpointing
    log_freq: int = 250
    save_freq: int = 1000
    eval_freq: int = 0
    save_checkpoint: bool = True

    # Output configuration
    output_dir: str = "outputs/train"
    resume: bool = False
    job_name: Optional[str] = None

    # Weights & Biases
    wandb_enable: bool = False
    wandb_project: Optional[str] = None
    wandb_entity: Optional[str] = None
    wandb_notes: Optional[str] = None
    wandb_run_id: Optional[str] = None
    wandb_mode: Optional[str] = "online"
    wandb_disable_artifact: bool = False

    # Environment / evaluation
    env_type: Optional[str] = None
    env_task: Optional[str] = None
    eval_n_episodes: int = 10
    eval_batch_size: int = 50
    eval_use_async_envs: bool = False

    # Policy-specific
    policy_device: Optional[str] = "cuda"
    policy_use_amp: bool = False
    # Hub upload (set by HfCloudJobRunner; not exposed in the form)
    policy_push_to_hub: bool = False
    policy_repo_id: Optional[str] = None

    # Optimizer
    optimizer_type: Optional[str] = "adam"
    optimizer_lr: Optional[float] = None
    optimizer_weight_decay: Optional[float] = None
    optimizer_grad_clip_norm: Optional[float] = None

    # Advanced
    use_policy_training_preset: bool = True
    config_path: Optional[str] = None


def build_training_command(request: TrainingRequest, output_dir: str) -> List[str]:
    """Build the argv list to invoke `python -m lerobot.scripts.lerobot_train`.

    `output_dir` is supplied separately from the request so the caller (the
    JobRegistry) can pin it to the per-job directory rather than relying on
    request.output_dir, which the frontend doesn't even send in the new world.
    """
    cmd: List[str] = ["python", "-m", "lerobot.scripts.lerobot_train"]

    # Dataset
    cmd.extend(["--dataset.repo_id", request.dataset_repo_id])
    if request.dataset_revision:
        cmd.extend(["--dataset.revision", request.dataset_revision])
    if request.dataset_root:
        cmd.extend(["--dataset.root", request.dataset_root])
    if request.dataset_episodes:
        cmd.extend(["--dataset.episodes"] + [str(ep) for ep in request.dataset_episodes])

    # Policy
    cmd.extend(["--policy.type", request.policy_type])

    # Core training params
    cmd.extend(["--steps", str(request.steps)])
    cmd.extend(["--batch_size", str(request.batch_size)])
    cmd.extend(["--num_workers", str(request.num_workers)])
    if request.seed is not None:
        cmd.extend(["--seed", str(request.seed)])

    # Policy device / AMP / hub
    if request.policy_device:
        cmd.extend(["--policy.device", request.policy_device])
    cmd.extend(["--policy.use_amp", "true" if request.policy_use_amp else "false"])
    # LeRobot defaults push_to_hub=True and demands --policy.repo_id when so.
    # Local jobs keep it off; HF Cloud jobs flip it on via the runner.
    cmd.extend(["--policy.push_to_hub", "true" if request.policy_push_to_hub else "false"])
    if request.policy_push_to_hub and request.policy_repo_id:
        cmd.extend(["--policy.repo_id", request.policy_repo_id])

    # Logging / checkpointing
    cmd.extend(["--log_freq", str(request.log_freq)])
    cmd.extend(["--save_freq", str(request.save_freq)])
    cmd.extend(["--eval_freq", str(request.eval_freq)])
    cmd.extend(["--save_checkpoint", "true" if request.save_checkpoint else "false"])

    # Output
    cmd.extend(["--output_dir", output_dir])
    cmd.extend(["--resume", "true" if request.resume else "false"])
    if request.job_name:
        cmd.extend(["--job_name", request.job_name])

    # W&B
    cmd.extend(["--wandb.enable", "true" if request.wandb_enable else "false"])
    if request.wandb_enable:
        if request.wandb_project:
            cmd.extend(["--wandb.project", request.wandb_project])
        if request.wandb_entity:
            cmd.extend(["--wandb.entity", request.wandb_entity])
        if request.wandb_notes:
            cmd.extend(["--wandb.notes", request.wandb_notes])
        if request.wandb_run_id:
            cmd.extend(["--wandb.run_id", request.wandb_run_id])
        if request.wandb_mode:
            cmd.extend(["--wandb.mode", request.wandb_mode])
        cmd.extend(["--wandb.disable_artifact", "true" if request.wandb_disable_artifact else "false"])

    # Env
    if request.env_type:
        cmd.extend(["--env.type", request.env_type])
    if request.env_task:
        cmd.extend(["--env.task", request.env_task])

    # Eval
    cmd.extend(["--eval.n_episodes", str(request.eval_n_episodes)])
    cmd.extend(["--eval.batch_size", str(request.eval_batch_size)])
    cmd.extend(["--eval.use_async_envs", "true" if request.eval_use_async_envs else "false"])

    # Optimizer
    if request.optimizer_type:
        cmd.extend(["--optimizer.type", request.optimizer_type])
    if request.optimizer_lr is not None:
        cmd.extend(["--optimizer.lr", str(request.optimizer_lr)])
    if request.optimizer_weight_decay is not None:
        cmd.extend(["--optimizer.weight_decay", str(request.optimizer_weight_decay)])
    if request.optimizer_grad_clip_norm is not None:
        cmd.extend(["--optimizer.grad_clip_norm", str(request.optimizer_grad_clip_norm)])

    # Advanced
    cmd.extend(["--use_policy_training_preset", "true" if request.use_policy_training_preset else "false"])
    if request.config_path:
        cmd.extend(["--config_path", request.config_path])

    return cmd
