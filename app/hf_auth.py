import logging

from huggingface_hub import login as hf_login, whoami
from huggingface_hub.errors import HfHubHTTPError, LocalTokenNotFoundError

logger = logging.getLogger(__name__)

LOGIN_COMMAND = "hf auth login"


def handle_hf_auth_status() -> dict:
    try:
        info = whoami()
        return {
            "authenticated": True,
            "username": info["name"],
            "orgs": [o["name"] for o in info.get("orgs", [])],
            "login_command": LOGIN_COMMAND,
        }
    except (LocalTokenNotFoundError, HfHubHTTPError, OSError) as e:
        logger.info(f"HF auth check: not authenticated ({type(e).__name__})")
        return {
            "authenticated": False,
            "username": None,
            "orgs": [],
            "login_command": LOGIN_COMMAND,
        }


def handle_hf_login(token: str) -> dict:
    """Validate and persist an HF token pasted from the UI.

    whoami() validates the token; on success, huggingface_hub.login() writes
    it to ~/.cache/huggingface/token (same as `hf auth login`). Subsequent
    get_token() calls then pick it up automatically.
    """
    token = (token or "").strip()
    if not token:
        raise ValueError("Token must not be empty")
    try:
        info = whoami(token=token)
    except HfHubHTTPError as exc:
        raise ValueError(f"Invalid token: {exc}") from exc
    hf_login(token=token, add_to_git_credential=False)
    return {
        "authenticated": True,
        "username": info["name"],
        "orgs": [o["name"] for o in info.get("orgs", [])],
        "login_command": LOGIN_COMMAND,
    }
