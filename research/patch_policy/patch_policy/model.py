"""Patch Policy — reimplementation of arXiv:2607.18236 (Zhou et al., NYU/Meta-FAIR).

"Patch Policy: Efficient Embodied Control via Dense Visual Representations."

Core idea: feed the FULL grid of patch tokens from a frozen, pretrained ViT
(DINOv2 ViT-S/14 -> 16x16 = 256 patches x 384-dim per 224x224 image) into a
small transformer policy, instead of pooling each image to one global token.

Faithful-to-paper choices:
  * frozen encoder, no fine-tuning; patch features consumed directly
    (paper's real-world config uses policy embed dim 384 == ViT-S dim; a linear
    projection kicks in only when the dims differ)
  * tokens flattened to one sequence of length T*P with a LEARNED 1D positional
    embedding indexed by flattened position
  * block-causal attention: full bidirectional attention within a frame,
    causal across frames
  * the action chunk is decoded at the LAST patch token of each frame; the loss
    is applied at every frame (not just the final one)
  * vision-only by default (the paper's real-robot tasks use no proprioception)
  * real-world recipe: T=2 obs window, chunk 5-10, batch 128, lr 3e-4, wd 1e-4

Documented deviation: the paper evaluates VQ-BeT and Diffusion-Policy heads.
v0 here uses a chunked L1-regression head (ACT-style, no VAE) — the trunk is
the paper's contribution and the head is explicitly interchangeable; the
VQ-BeT head (LeRobot ships one) is the natural v1 upgrade. The DP head is not
planned: the paper measures it ~40x slower at inference (denoising-bound).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import torch
import torch.nn.functional as F
from torch import nn

# ImageNet statistics — DINOv2 was trained with these; images entering the
# encoder must be float in [0,1], then normalized.
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


@dataclass
class PatchPolicyConfig:
    action_dim: int
    cameras: tuple[str, ...] = ("front",)
    obs_window: int = 2          # T — frames of history (paper real-world: 2)
    chunk_size: int = 5          # actions predicted per frame (paper: 5-10)
    image_size: int = 224
    # ViT-S/14 on 224x224 -> (224/14)^2 = 256 patches, 384-dim features.
    patches_per_image: int = 256
    encoder_dim: int = 384
    encoder: str = "dinov2_vits14"  # "fake" = tiny random conv patchifier (tests)
    embed_dim: int = 384
    depth: int = 8
    heads: int = 8
    mlp_ratio: float = 4.0
    dropout: float = 0.0
    # Filled from dataset stats by the trainer; identity until then.
    action_mean: tuple[float, ...] = field(default_factory=tuple)
    action_std: tuple[float, ...] = field(default_factory=tuple)

    @property
    def patches_per_frame(self) -> int:
        """P — all cameras' patches concatenated form one frame."""
        return self.patches_per_image * len(self.cameras)

    @property
    def seq_len(self) -> int:
        return self.obs_window * self.patches_per_frame


def block_causal_mask(num_frames: int, patches_per_frame: int, device=None) -> torch.Tensor:
    """Boolean attention mask of shape (S, S), True = may attend.

    A token in frame i attends to every token in frames <= i (full bidirectional
    inside its own frame, causal across frames) — the paper's block-causal mask.
    """
    frame_index = torch.arange(num_frames, device=device).repeat_interleave(patches_per_frame)
    return frame_index[None, :] <= frame_index[:, None]


class FakePatchEncoder(nn.Module):
    """Deterministic stand-in encoder for tests: conv patchify, no pretraining,
    no network access. Matches the (B, P, D) contract of the real encoder."""

    def __init__(self, image_size: int, patches_per_image: int, dim: int):
        super().__init__()
        grid = int(patches_per_image ** 0.5)
        if grid * grid != patches_per_image:
            raise ValueError("patches_per_image must be a perfect square")
        if image_size % grid:
            raise ValueError("image_size must be divisible by the patch grid")
        self.proj = nn.Conv2d(3, dim, kernel_size=image_size // grid, stride=image_size // grid)
        for p in self.parameters():
            p.requires_grad_(False)

    def forward(self, images: torch.Tensor) -> torch.Tensor:
        return self.proj(images).flatten(2).transpose(1, 2)  # (B, P, D)


class DinoV2Encoder(nn.Module):
    """Frozen DINOv2 dense-patch encoder (downloads via torch.hub on first use)."""

    def __init__(self, variant: str):
        super().__init__()
        self.backbone = torch.hub.load("facebookresearch/dinov2", variant)
        self.backbone.eval()
        for p in self.backbone.parameters():
            p.requires_grad_(False)

    def train(self, mode: bool = True):  # noqa: ARG002 - encoder stays in eval
        return super().train(False)

    @torch.no_grad()
    def forward(self, images: torch.Tensor) -> torch.Tensor:
        return self.backbone.forward_features(images)["x_norm_patchtokens"]


def build_encoder(cfg: PatchPolicyConfig) -> nn.Module:
    if cfg.encoder == "fake":
        return FakePatchEncoder(cfg.image_size, cfg.patches_per_image, cfg.encoder_dim)
    return DinoV2Encoder(cfg.encoder)


class Block(nn.Module):
    """Pre-LN transformer block; attention runs through SDPA with our mask."""

    def __init__(self, dim: int, heads: int, mlp_ratio: float, dropout: float):
        super().__init__()
        if dim % heads:
            raise ValueError("embed_dim must be divisible by heads")
        self.heads = heads
        self.norm1 = nn.LayerNorm(dim)
        self.qkv = nn.Linear(dim, dim * 3)
        self.attn_out = nn.Linear(dim, dim)
        self.norm2 = nn.LayerNorm(dim)
        hidden = int(dim * mlp_ratio)
        self.mlp = nn.Sequential(
            nn.Linear(dim, hidden), nn.GELU(), nn.Dropout(dropout), nn.Linear(hidden, dim)
        )
        self.drop = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        b, s, d = x.shape
        q, k, v = self.qkv(self.norm1(x)).chunk(3, dim=-1)
        shape = (b, s, self.heads, d // self.heads)
        q, k, v = (t.view(shape).transpose(1, 2) for t in (q, k, v))
        attn = F.scaled_dot_product_attention(q, k, v, attn_mask=mask)
        x = x + self.drop(self.attn_out(attn.transpose(1, 2).reshape(b, s, d)))
        return x + self.drop(self.mlp(self.norm2(x)))


class PatchPolicy(nn.Module):
    def __init__(self, cfg: PatchPolicyConfig):
        super().__init__()
        self.cfg = cfg
        self.encoder = build_encoder(cfg)
        self.proj = (
            nn.Identity() if cfg.encoder_dim == cfg.embed_dim
            else nn.Linear(cfg.encoder_dim, cfg.embed_dim)
        )
        self.pos_embed = nn.Parameter(torch.zeros(1, cfg.seq_len, cfg.embed_dim))
        nn.init.trunc_normal_(self.pos_embed, std=0.02)
        self.blocks = nn.ModuleList(
            Block(cfg.embed_dim, cfg.heads, cfg.mlp_ratio, cfg.dropout) for _ in range(cfg.depth)
        )
        self.norm = nn.LayerNorm(cfg.embed_dim)
        self.action_head = nn.Sequential(
            nn.Linear(cfg.embed_dim, cfg.embed_dim),
            nn.GELU(),
            nn.Linear(cfg.embed_dim, cfg.chunk_size * cfg.action_dim),
        )
        mask = block_causal_mask(cfg.obs_window, cfg.patches_per_frame)
        self.register_buffer("attn_mask", mask, persistent=False)
        mean = torch.tensor(cfg.action_mean or [0.0] * cfg.action_dim, dtype=torch.float32)
        std = torch.tensor(cfg.action_std or [1.0] * cfg.action_dim, dtype=torch.float32)
        self.register_buffer("act_mean", mean)
        self.register_buffer("act_std", std.clamp_min(1e-6))
        imagenet_mean = torch.tensor(IMAGENET_MEAN).view(1, 3, 1, 1)
        imagenet_std = torch.tensor(IMAGENET_STD).view(1, 3, 1, 1)
        self.register_buffer("img_mean", imagenet_mean, persistent=False)
        self.register_buffer("img_std", imagenet_std, persistent=False)

    def trainable_parameters(self):
        return (p for p in self.parameters() if p.requires_grad)

    def _encode_frames(self, images: dict[str, torch.Tensor]) -> torch.Tensor:
        """images: camera -> (B, T, 3, H, W) float in [0,1]. Returns (B, T*P, embed)."""
        cfg = self.cfg
        per_camera = []
        for camera in cfg.cameras:  # fixed camera order = fixed patch layout
            frames = images[camera]
            b, t = frames.shape[:2]
            flat = frames.flatten(0, 1)
            flat = (flat - self.img_mean) / self.img_std
            feats = self.encoder(flat)  # (B*T, P_img, D)
            per_camera.append(feats.view(b, t, cfg.patches_per_image, -1))
        frames = torch.cat(per_camera, dim=2)  # (B, T, P, D)
        return self.proj(frames.flatten(1, 2))

    def forward(self, images: dict[str, torch.Tensor]) -> torch.Tensor:
        """Returns per-frame NORMALIZED action chunks: (B, T, chunk, action_dim)."""
        cfg = self.cfg
        x = self._encode_frames(images)
        if x.shape[1] != cfg.seq_len:
            raise ValueError(f"expected sequence {cfg.seq_len}, got {x.shape[1]}")
        x = x + self.pos_embed
        for block in self.blocks:
            x = block(x, self.attn_mask)
        x = self.norm(x)
        # Decode the chunk at the LAST patch token of each frame (paper Sec. 3).
        last = torch.arange(1, cfg.obs_window + 1, device=x.device) * cfg.patches_per_frame - 1
        readout = x[:, last, :]
        return self.action_head(readout).view(-1, cfg.obs_window, cfg.chunk_size, cfg.action_dim)

    def loss(
        self,
        images: dict[str, torch.Tensor],
        target_actions: torch.Tensor,   # (B, T, chunk, action_dim) RAW (unnormalized)
        target_pad: torch.Tensor | None = None,  # (B, T, chunk) True = padded step
    ) -> torch.Tensor:
        pred = self.forward(images)
        target = (target_actions - self.act_mean) / self.act_std
        err = (pred - target).abs()
        if target_pad is not None:
            keep = (~target_pad).unsqueeze(-1).to(err.dtype)
            return (err * keep).sum() / keep.sum().clamp_min(1.0) / self.cfg.action_dim
        return err.mean()

    @torch.no_grad()
    def act(self, images: dict[str, torch.Tensor]) -> torch.Tensor:
        """images: camera -> (1, T, 3, H, W). Returns the latest frame's chunk,
        DENORMALIZED: (chunk, action_dim). Callers with < T frames of history
        should repeat the oldest frame to fill the window."""
        was_training = self.training
        self.eval()
        try:
            pred = self.forward(images)[:, -1]  # (1, chunk, action_dim)
        finally:
            self.train(was_training)
        return (pred * self.act_std + self.act_mean).squeeze(0)
