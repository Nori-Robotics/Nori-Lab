import logging
from typing import Any

from huggingface_hub import HfApi, whoami
from huggingface_hub.errors import HfHubHTTPError, LocalTokenNotFoundError

logger = logging.getLogger(__name__)


def list_user_datasets() -> list[dict[str, Any]]:
    try:
        info = whoami()
    except (LocalTokenNotFoundError, HfHubHTTPError, OSError):
        return []

    authors = [info["name"]] + [o["name"] for o in info.get("orgs", [])]
    api = HfApi()
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for author in authors:
        try:
            for ds in api.list_datasets(author=author, filter="LeRobot", limit=200):
                if ds.id in seen:
                    continue
                seen.add(ds.id)
                out.append({
                    "repo_id": ds.id,
                    "last_modified": ds.last_modified.isoformat() if ds.last_modified else None,
                    "private": bool(getattr(ds, "private", False)),
                })
        except HfHubHTTPError as e:
            logger.warning(f"list_datasets({author}) failed: {e}")

    out.sort(key=lambda d: d["last_modified"] or "", reverse=True)
    return out
