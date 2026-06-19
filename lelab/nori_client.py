# NORI: Additive file. HTTP client for the Nori-Backend cloud API.
#
# This is the single chokepoint for all laptop -> Nori-Backend traffic. It exists so the
# feature modules (datasets.py, jobs.py, train.py) never talk to Hugging Face directly:
# every dataset upload, training dispatch, and policy download is mediated by Nori-Backend,
# which holds the one org-admin HF token. See NORI_PLAN.md "The invariant".
#
# Auth model: this client never holds a long-lived secret. It receives a short-lived
# Supabase JWT (forwarded from the browser via the `X-Nori-JWT` header on the inbound
# LeLab request) and passes it straight through as `Authorization: Bearer <jwt>` on the
# outbound call. Nori-Backend validates it (via JWKS); the laptop never does.

from __future__ import annotations

import logging
from typing import Any, Literal

import httpx

from .utils.config import NORI_BACKEND_URL

logger = logging.getLogger(__name__)

API = "/api/v1"
DEFAULT_TIMEOUT = httpx.Timeout(30.0, connect=10.0)

PolicySource = Literal["own", "first_party", "community"]


class NoriBackendError(RuntimeError):
    """Raised when Nori-Backend returns a non-2xx response.

    Carries the HTTP status and the parsed `detail` (FastAPI's error field) so callers /
    the server layer can translate it into an appropriate HTTPException for the frontend.
    """

    def __init__(self, message: str, status_code: int, detail: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.detail = detail


class NoriClient:
    """Thin, typed wrapper over Nori-Backend's `/api/v1` surface.

    One instance per inbound request is fine (construction is cheap). Pass the caller's
    JWT once at construction; every method forwards it. Methods that are part of a later
    phase raise NotImplementedError with a pointer to the phase rather than silently
    no-op'ing, so wiring gaps are loud.
    """

    def __init__(self, jwt: str | None = None, base_url: str = NORI_BACKEND_URL):
        self.base_url = base_url.rstrip("/")
        self.jwt = jwt

    # -- low-level -----------------------------------------------------------------

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers: dict[str, str] = {"Accept": "application/json"}
        if self.jwt:
            headers["Authorization"] = f"Bearer {self.jwt}"
        if extra:
            headers.update(extra)
        return headers

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        """Issue a request and return parsed JSON, raising NoriBackendError on non-2xx."""
        url = f"{self.base_url}{path}"
        try:
            with httpx.Client(timeout=DEFAULT_TIMEOUT) as client:
                resp = client.request(
                    method, url, json=json, params=params, headers=self._headers()
                )
        except httpx.RequestError as exc:
            # Network-level failure (backend down, DNS, timeout). Surface as a 502-ish.
            raise NoriBackendError(
                f"Could not reach Nori-Backend at {url}: {exc}", status_code=502
            ) from exc

        if resp.is_success:
            if resp.status_code == 204 or not resp.content:
                return None
            return resp.json()

        detail: Any = None
        try:
            body = resp.json()
            detail = body.get("detail", body) if isinstance(body, dict) else body
        except ValueError:
            detail = resp.text or None
        raise NoriBackendError(
            f"{method} {path} -> {resp.status_code}: {detail}",
            status_code=resp.status_code,
            detail=detail,
        )

    # -- customers / provisioning (Phase 2) ----------------------------------------

    def provision_customer(self) -> dict[str, Any]:
        """POST /customers/me/provision — idempotent; safe on every sign-in."""
        return self._request("POST", f"{API}/customers/me/provision")

    def get_customer(self) -> dict[str, Any]:
        """GET /customers/me — returns {provisioned: false, ...} if not yet provisioned."""
        return self._request("GET", f"{API}/customers/me")

    # -- pairing (Phase 6) ---------------------------------------------------------

    def pair_robot(self, robot_serial_number: str) -> dict[str, Any]:
        """POST /customers/me/pair — 409 if re-pairing to a different serial."""
        return self._request(
            "POST", f"{API}/customers/me/pair", json={"robot_serial_number": robot_serial_number}
        )

    # -- marketplace (Phase 3) -----------------------------------------------------

    def list_policies(self, source: PolicySource | None = None) -> Any:
        """GET /marketplace/policies (?source=own|first_party|community)."""
        params = {"source": source} if source else None
        return self._request("GET", f"{API}/marketplace/policies", params=params)

    def acquire_policy(self, listing_id: str) -> dict[str, Any]:
        """POST /marketplace/policies/{listing_id}/acquire."""
        return self._request("POST", f"{API}/marketplace/policies/{listing_id}/acquire")

    def list_public_datasets(self) -> Any:
        """GET /marketplace/datasets/public (auth-optional)."""
        return self._request("GET", f"{API}/marketplace/datasets/public")

    def download_policy(self, ref: str, dest_dir: str) -> str:
        """GET /marketplace/policies/{ref}/download — stream bytes to local cache.

        Phase 3 work: stream the StreamingResponse to `dest_dir` and return the path.
        `ref` = jobs.id (own) or marketplace_listings.id.
        """
        raise NotImplementedError("Phase 3: marketplace policy download streaming")

    # -- training (Phase 4 dispatch + log polling) ---------------------------------

    def dispatch_training(self, timeout_seconds: int) -> dict[str, Any]:
        """POST /training/dispatch — body {timeout_seconds: 60..3600}.

        Returns {internal_job_uuid, hf_job_id, ...}.
        """
        return self._request(
            "POST", f"{API}/training/dispatch", json={"timeout_seconds": timeout_seconds}
        )

    def list_jobs(self) -> Any:
        """GET /training/jobs."""
        return self._request("GET", f"{API}/training/jobs")

    def get_job(self, job_id: str) -> dict[str, Any]:
        """GET /training/jobs/{job_id}."""
        return self._request("GET", f"{API}/training/jobs/{job_id}")

    def get_job_logs(self, job_id: str, since: int = 0) -> dict[str, Any]:
        """GET /training/jobs/{job_id}/logs?since=<offset>.

        Returns {lines, next_offset, job_status, is_terminal}. Client polls ~2s.
        """
        return self._request(
            "GET", f"{API}/training/jobs/{job_id}/logs", params={"since": since}
        )

    # -- dataset upload: 4-step presigned-S3 flow (Phase 4) ------------------------

    def start_dataset_upload(self, manifest: list[dict[str, Any]]) -> dict[str, Any]:
        """POST /datasets/upload/start — manifest [{path, size}, ...].

        Returns {session_id, uploads: [{path, put_url}], expires_at}.
        """
        return self._request(
            "POST", f"{API}/datasets/upload/start", json={"files": manifest}
        )

    def finalize_dataset_upload(self, session_id: str) -> dict[str, Any]:
        """POST /datasets/upload/{session_id}/finalize.

        On HEAD-miss returns 422 {reason, missing: [paths]} (NoriBackendError.detail).
        """
        return self._request("POST", f"{API}/datasets/upload/{session_id}/finalize")

    def get_dataset_upload(self, session_id: str) -> dict[str, Any]:
        """GET /datasets/upload/{session_id} — poll during FINALIZING."""
        return self._request("GET", f"{API}/datasets/upload/{session_id}")

    def cancel_dataset_upload(self, session_id: str) -> dict[str, Any]:
        """POST /datasets/upload/{session_id}/cancel."""
        return self._request("POST", f"{API}/datasets/upload/{session_id}/cancel")

    def upload_dataset(self, local_path: str) -> dict[str, Any]:
        """Full 4-step upload: build manifest -> start -> PUT each file to S3 (with
        `x-amz-server-side-encryption: AES256`) -> finalize (retry missing) -> poll.

        Phase 4 work; orchestrates the methods above + the laptop-side S3 PUTs.
        """
        raise NotImplementedError("Phase 4: full presigned-S3 dataset upload orchestration")

    # -- consents (Phase 6) --------------------------------------------------------

    def list_consents(self) -> Any:
        """GET /consents."""
        return self._request("GET", f"{API}/consents")

    def post_consent(self, consent_type: str, granted: bool) -> dict[str, Any]:
        """POST /consents — e.g. train_self / publish_public toggles."""
        return self._request(
            "POST", f"{API}/consents", json={"consent_type": consent_type, "granted": granted}
        )

    def revoke_consent(self, consent_id: str) -> dict[str, Any]:
        """POST /consents/{id}/revoke."""
        return self._request("POST", f"{API}/consents/{consent_id}/revoke")

    # -- deletion requests (Phase 6) -----------------------------------------------

    def create_deletion_request(self, payload: dict[str, Any]) -> dict[str, Any]:
        """POST /deletion-requests (backend purge sweeper not yet wired — status row only)."""
        return self._request("POST", f"{API}/deletion-requests", json=payload)
