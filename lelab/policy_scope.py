"""Scoped-policy feature subsetting.

Train a policy that targets only specific cameras and/or arms by SUBSETTING the
recorded (full-robot) dataset's features before training: keep only the selected
`observation.images.<cam>` keys, and index-select the selected joints' columns
out of `observation.state` and `action` (with the normalization stats sliced to
match). lerobot's ACT/diffusion auto-configure to whatever features the dataset
exposes, so the trained policy's input/output dims come out scoped for free.

The resolved scope (cameras + the exact joint-name lists) is stamped into
`nori_meta.json` so rollout can (a) feed only the scoped cameras and (b) build a
joint list matching the policy's output dim. The daemon applies a partial action
dict safely — joints absent from a control frame hold their last pose under
torque (verified in NoriTelop control.cpp apply_action) — so a one-arm policy
leaves the other arm held/teleoperable.

Joint→arm mapping is by NAME PREFIX (left_arm_* / right_arm_*): on the follower
each arm has its own bus, so motor IDs repeat 1-6 across arms and the prefix is
the disambiguator.

This module is pure/serializable (no torch) so it can run in the training
container ahead of `lerobot-train` and be unit-tested without a real dataset.
The parquet column-slice that applies `state_indices`/`action_indices` to the
data files is `plan_parquet_slice()` here + a pyarrow apply step at call time.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Actuator tokens that mean "keep everything".
_ALL_TOKENS = {"all", "both", "whole", "whole_robot", "robot", "*"}


class ScopeError(ValueError):
    """Raised when a requested scope can't be satisfied by the dataset."""


@dataclass
class ResolvedScope:
    image_keys: list[str]          # full dataset keys, e.g. "observation.images.overhead"
    state_indices: list[int]       # columns to keep from observation.state
    state_joints: list[str]
    action_indices: list[int]      # columns to keep from action
    action_joints: list[str]
    dropped_image_keys: list[str] = field(default_factory=list)

    def to_meta(self, actuators: list[str], cameras_req: list[str] | None) -> dict:
        """The `scope` block stamped into nori_meta.json for rollout."""
        return {
            "cameras": [_short_cam(k) for k in self.image_keys],
            "actuators": actuators,
            "action_joints": self.action_joints,
            "state_joints": self.state_joints,
        }


def _short_cam(key: str) -> str:
    """"observation.images.left_wrist" -> "left_wrist"; passthrough otherwise."""
    return key.rsplit(".", 1)[-1] if "." in key else key


def _match_camera(requested: str, available: list[str]) -> str | None:
    """Resolve a requested camera (short name or full key) to a full dataset key."""
    if requested in available:
        return requested
    for key in available:
        if _short_cam(key) == requested or _short_cam(key) == _short_cam(requested):
            return key
    return None


def _actuator_predicate(actuators: list[str]):
    """Return a fn(joint_name)->bool selecting joints for the given actuators.

    "left"/"right" match the left_arm_/right_arm_ (or left_/right_) name prefix;
    any all/both/whole token keeps every joint.
    """
    acts = [a.strip().lower() for a in actuators if a and a.strip()]
    if not acts or any(a in _ALL_TOKENS for a in acts):
        return lambda _name: True

    prefixes: list[str] = []
    for a in acts:
        # accept "left", "left_arm", "left_arm_" etc. -> normalize to a prefix
        prefixes.append(a if a.endswith("_") else a + "_")

    def keep(name: str) -> bool:
        low = name.lower()
        return any(low.startswith(p) or low.startswith(p.rstrip("_")) for p in prefixes)

    return keep


def resolve_scope(
    *,
    image_keys_available: list[str],
    state_names: list[str],
    action_names: list[str],
    cameras: list[str] | None,
    actuators: list[str] | None,
) -> ResolvedScope:
    """Resolve a scope request against a dataset's actual features.

    cameras: requested camera short-names/keys; None/empty -> keep all.
    actuators: e.g. ["left"], ["left","right"], ["whole"]; None/empty -> keep all.
    Raises ScopeError on an unsatisfiable request (unknown camera, no matching
    joints, or an empty selection).
    """
    # --- cameras ---
    if cameras:
        resolved_keys: list[str] = []
        for req in cameras:
            key = _match_camera(req, image_keys_available)
            if key is None:
                raise ScopeError(
                    f"camera {req!r} not in dataset (have: "
                    f"{[_short_cam(k) for k in image_keys_available]})"
                )
            if key not in resolved_keys:
                resolved_keys.append(key)
    else:
        resolved_keys = list(image_keys_available)
    if not resolved_keys:
        raise ScopeError("scope selects zero cameras")
    dropped = [k for k in image_keys_available if k not in resolved_keys]

    # --- joints ---
    keep = _actuator_predicate(actuators or [])
    state_sel = [(i, n) for i, n in enumerate(state_names) if keep(n)]
    action_sel = [(i, n) for i, n in enumerate(action_names) if keep(n)]
    if not action_sel:
        raise ScopeError(
            f"actuators {actuators!r} match no action joints "
            f"(have: {action_names})"
        )
    if not state_sel:
        raise ScopeError(
            f"actuators {actuators!r} match no state joints (have: {state_names})"
        )

    return ResolvedScope(
        image_keys=resolved_keys,
        state_indices=[i for i, _ in state_sel],
        state_joints=[n for _, n in state_sel],
        action_indices=[i for i, _ in action_sel],
        action_joints=[n for _, n in action_sel],
        dropped_image_keys=dropped,
    )


# --------------------------------------------------------------------------- #
# meta/info.json + stats transforms (pure dict ops)                           #
# --------------------------------------------------------------------------- #
def _slice_names(feat: dict, indices: list[int]) -> list | dict:
    """Slice a feature's `names` to `indices`, preserving list vs {motors:[...]}."""
    names = feat.get("names")
    if isinstance(names, dict):
        # e.g. {"motors": [...]}: slice the single list value
        out = {}
        for k, v in names.items():
            out[k] = [v[i] for i in indices] if isinstance(v, list) else v
        return out
    if isinstance(names, list):
        return [names[i] for i in indices]
    return names


def scope_info(info: dict, resolved: ResolvedScope) -> dict:
    """Return a new meta/info.json dict with features subset to the scope."""
    out = dict(info)
    feats = dict(info.get("features", {}))

    for key, indices in (
        ("observation.state", resolved.state_indices),
        ("action", resolved.action_indices),
    ):
        if key not in feats:
            continue
        f = dict(feats[key])
        shape = list(f.get("shape", [len(indices)]))
        # 1-D motor vector: replace the (single) dim with the kept count.
        f["shape"] = [len(indices)] if len(shape) <= 1 else [len(indices), *shape[1:]]
        f["names"] = _slice_names(f, indices)
        feats[key] = f

    for key in resolved.dropped_image_keys:
        feats.pop(key, None)

    out["features"] = feats
    return out


def scope_stats(stats: dict, resolved: ResolvedScope) -> dict:
    """Return a new stats dict with state/action stat vectors sliced + dropped
    image keys removed. Handles the per-stat arrays (mean/std/min/max/q*)."""
    out: dict[str, Any] = {}
    for key, val in stats.items():
        if key in resolved.dropped_image_keys:
            continue
        if key == "observation.state":
            out[key] = _slice_stat_entry(val, resolved.state_indices)
        elif key == "action":
            out[key] = _slice_stat_entry(val, resolved.action_indices)
        else:
            out[key] = val
    return out


def _slice_stat_entry(entry: dict, indices: list[int]) -> dict:
    """Slice each per-dimension stat array (mean/std/min/max/q01/…) to indices.
    Leaves scalars (e.g. `count`) untouched."""
    out = {}
    for stat_name, arr in entry.items():
        if isinstance(arr, list) and arr and not isinstance(arr[0], (list, dict)):
            # 1-D per-dimension vector
            if len(arr) >= max(indices, default=-1) + 1:
                out[stat_name] = [arr[i] for i in indices]
            else:
                out[stat_name] = arr
        else:
            out[stat_name] = arr
    return out


def plan_parquet_slice(resolved: ResolvedScope) -> dict:
    """Describe the column edits a pyarrow pass must apply to each data parquet:
    slice the `observation.state` and `action` list-columns to the kept indices,
    and drop the video/image columns for cameras not in scope."""
    return {
        "observation.state": {"keep_indices": resolved.state_indices},
        "action": {"keep_indices": resolved.action_indices},
        "drop_columns": list(resolved.dropped_image_keys),
    }


# --------------------------------------------------------------------------- #
# Physical apply: materialize a scoped COPY (source is never mutated)          #
# --------------------------------------------------------------------------- #
def apply_scope_to_dataset(src_root, dst_root, resolved: ResolvedScope):
    """Write a scoped COPY of a LeRobotDataset v3 to `dst_root`, leaving the
    source untouched. Subtracts only:
      - meta/info.json  : features subset to the scope (scope_info)
      - meta/stats.json : normalization stat vectors sliced (scope_stats)
      - data/**.parquet : observation.state + action list-columns sliced
      - videos/         : video trees for out-of-scope cameras removed

    Requires pyarrow (present in the lerobot env). Returns dst_root.

    Note: per-episode stats in meta/episodes/*.parquet are left full-width — the
    train-time normalizer loads meta/stats.json (io_utils.load_stats), not the
    per-episode stats, so this is cosmetic, not a correctness issue.
    """
    import json
    import shutil
    from pathlib import Path

    src = Path(src_root)
    dst = Path(dst_root)
    if dst.exists():
        raise FileExistsError(f"scoped destination already exists: {dst}")
    dst.mkdir(parents=True)

    # 1. meta — copy tree, then rewrite info.json + stats.json
    shutil.copytree(src / "meta", dst / "meta")
    info_path = dst / "meta" / "info.json"
    info = json.loads(info_path.read_text())
    info_path.write_text(json.dumps(scope_info(info, resolved), indent=2))
    stats_path = dst / "meta" / "stats.json"
    if stats_path.exists():
        stats = json.loads(stats_path.read_text())
        stats_path.write_text(json.dumps(scope_stats(stats, resolved), indent=2))

    # 2. data — slice the state/action list-columns in every data parquet
    data_dir = src / "data"
    if data_dir.exists():
        for pqfile in sorted(data_dir.rglob("*.parquet")):
            out = dst / pqfile.relative_to(src)
            out.parent.mkdir(parents=True, exist_ok=True)
            _slice_parquet_file(pqfile, out, resolved)

    # 3. videos — copy, then prune out-of-scope cameras
    vids = src / "videos"
    if vids.exists():
        shutil.copytree(vids, dst / "videos")
        for key in resolved.dropped_image_keys:
            _remove_camera_videos(dst / "videos", key)

    # 4. any other top-level members (tasks.parquet, etc.) — copy verbatim
    for child in src.iterdir():
        if child.name in ("meta", "data", "videos"):
            continue
        target = dst / child.name
        if child.is_dir():
            shutil.copytree(child, target)
        else:
            shutil.copy2(child, target)
    return dst


def _col_width(arr) -> int | None:
    import pyarrow as pa

    typ = arr.type
    if pa.types.is_fixed_size_list(typ):
        return typ.list_size
    for row in arr.to_pylist():
        if row is not None:
            return len(row)
    return None


def _slice_list_column(arr, indices: list[int]):
    """Slice each row's list to `indices`, preserving fixed-size-list vs list."""
    import pyarrow as pa

    typ = arr.type
    value_type = typ.value_type
    rows = arr.to_pylist()
    sliced = [None if r is None else [r[i] for i in indices] for r in rows]
    out_type = (
        pa.list_(value_type, len(indices))
        if pa.types.is_fixed_size_list(typ)
        else pa.list_(value_type)
    )
    return pa.array(sliced, type=out_type)


def _slice_parquet_file(src_path, dst_path, resolved: ResolvedScope):
    import pyarrow.parquet as pq

    table = pq.read_table(src_path)
    names = table.column_names
    for col, indices in (
        ("observation.state", resolved.state_indices),
        ("action", resolved.action_indices),
    ):
        if col not in names:
            continue
        arr = table.column(col)
        width = _col_width(arr)
        if width is None or list(indices) == list(range(width)):
            continue  # identity slice — leave the column as-is
        sliced = _slice_list_column(arr, indices)
        table = table.set_column(names.index(col), col, sliced)
    pq.write_table(table, dst_path)


def _remove_camera_videos(videos_root, key: str):
    import shutil
    from pathlib import Path

    short = _short_cam(key)
    for p in sorted(Path(videos_root).rglob("*"), reverse=True):
        if p.is_dir() and p.name in (key, short):
            shutil.rmtree(p, ignore_errors=True)


# --------------------------------------------------------------------------- #
# Container entrypoint                                                         #
# --------------------------------------------------------------------------- #
def _feature_names(feat) -> list:
    n = (feat or {}).get("names")
    if isinstance(n, dict):
        for v in n.values():  # e.g. {"motors": [...]} -> the single list
            if isinstance(v, list):
                return list(v)
        return []
    return list(n) if isinstance(n, list) else []


def _write_text(path, content: str):
    with open(path, "w") as f:
        f.write(content)


def run_scope_from_dir(ds_dir, out_dir, scope_json, root_out_path) -> str:
    """Training-container entrypoint. Given a staged dataset dir and a scope
    JSON string, write a scoped COPY to `out_dir` and record the dataset root to
    TRAIN ON into `root_out_path` (out_dir when scoped, else ds_dir).

    No-op that records ds_dir when `scope_json` is empty / whole-robot. RAISES
    if a requested scope can't be applied — better to fail the job than silently
    train the full robot when a scoped policy was asked for. Kept as a single
    high-level call so the container's injected shell stays brace-free.
    """
    import json as _json

    scope = None
    if scope_json:
        try:
            scope = _json.loads(scope_json)
        except Exception:
            scope = None
    if not scope or not (scope.get("cameras") or scope.get("actuators")):
        _write_text(root_out_path, str(ds_dir))
        return str(ds_dir)

    with open(f"{ds_dir}/meta/info.json") as f:
        feats = _json.load(f).get("features") or {}
    image_keys = [
        k for k, v in feats.items()
        if isinstance(v, dict) and str(v.get("dtype", "")).startswith(("video", "image"))
    ]
    resolved = resolve_scope(
        image_keys_available=image_keys,
        state_names=_feature_names(feats.get("observation.state")),
        action_names=_feature_names(feats.get("action")),
        cameras=scope.get("cameras"),
        actuators=scope.get("actuators"),
    )
    apply_scope_to_dataset(ds_dir, out_dir, resolved)
    _write_text(root_out_path, str(out_dir))
    print(
        f"SCOPE applied -> {out_dir} | "
        f"cameras={len(resolved.image_keys)} joints={len(resolved.action_joints)}"
    )
    return str(out_dir)
