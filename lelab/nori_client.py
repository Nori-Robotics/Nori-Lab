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
import os
import time
from pathlib import Path
from typing import Any, Literal

import httpx

from .utils.config import NORI_BACKEND_URL

logger = logging.getLogger(__name__)

API = "/api/v1"
DEFAULT_TIMEOUT = httpx.Timeout(30.0, connect=10.0)

PolicySource = Literal["own", "first_party", "community"]

# Manifest rules enforced client-side before /start (mirrors the backend; fail fast with a
# clear error instead of a round-trip rejection). See NORI_PLAN.md dataset-upload section.
UPLOAD_ALLOWED_EXTENSIONS = {".parquet", ".json", ".mp4", ".mkv", ".txt", ".md", ".png", ".jpg"}
UPLOAD_MAX_FILE_BYTES = 5 * 1024**3  # 5 GB / file
UPLOAD_MAX_TOTAL_BYTES = 20 * 1024**3  # 20 GB total
UPLOAD_REQUIRED_FILE = "info.json"
# Terminal upload-session states (GET /datasets/upload/{id}).status.
UPLOAD_TERMINAL_STATES = {"PROMOTED", "FAILED", "PROMOTION_FAILED", "CANCELLED"}
UPLOAD_SUCCESS_STATE = "PROMOTED"


class ManifestError(ValueError):
    """Raised when a dataset directory violates the upload manifest rules."""


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

    def download_policy(self, ref: str, dest_dir: str, filename: str = "model.safetensors") -> dict[str, Any]:
        """GET /marketplace/policies/{ref}/download — stream safetensors bytes to disk.

        Writes to `dest_dir/filename` atomically (via a .part temp file) and returns
        {ref, path, size_bytes}. `ref` = jobs.id (own) or marketplace_listings.id.
        """
        url = f"{self.base_url}{API}/marketplace/policies/{ref}/download"
        os.makedirs(dest_dir, exist_ok=True)
        final_path = os.path.join(dest_dir, filename)
        tmp_path = f"{final_path}.part"
        size = 0
        try:
            with (
                httpx.Client(timeout=httpx.Timeout(None, connect=10.0)) as client,
                client.stream("GET", url, headers=self._headers()) as resp,
            ):
                if not resp.is_success:
                    resp.read()
                    detail: Any
                    try:
                        body = resp.json()
                        detail = body.get("detail", body) if isinstance(body, dict) else body
                    except ValueError:
                        detail = resp.text or None
                    raise NoriBackendError(
                        f"GET {url} -> {resp.status_code}: {detail}",
                        status_code=resp.status_code,
                        detail=detail,
                    )
                with open(tmp_path, "wb") as f:
                    for chunk in resp.iter_bytes():
                        f.write(chunk)
                        size += len(chunk)
            os.replace(tmp_path, final_path)
        except httpx.RequestError as exc:
            raise NoriBackendError(
                f"Could not reach Nori-Backend at {url}: {exc}", status_code=502
            ) from exc
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        return {"ref": ref, "path": final_path, "size_bytes": size}

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

    def start_dataset_upload(
        self, manifest: list[dict[str, Any]], commit_message: str | None = None
    ) -> dict[str, Any]:
        """POST /datasets/upload/start — manifest [{path, size}, ...].

        Returns {session_id, uploads: [{path, put_url}], expires_at}.
        """
        body: dict[str, Any] = {"manifest": manifest}
        if commit_message is not None:
            body["commit_message"] = commit_message
        return self._request("POST", f"{API}/datasets/upload/start", json=body)

    def finalize_dataset_upload(
        self, session_id: str, commit_message: str | None = None
    ) -> dict[str, Any]:
        """POST /datasets/upload/{session_id}/finalize.

        On HEAD-miss returns 422 {reason, missing: [paths]} (NoriBackendError.detail).
        """
        body = {"commit_message": commit_message} if commit_message is not None else None
        return self._request(
            "POST", f"{API}/datasets/upload/{session_id}/finalize", json=body
        )

    def get_dataset_upload(self, session_id: str) -> dict[str, Any]:
        """GET /datasets/upload/{session_id} — poll during FINALIZING."""
        return self._request("GET", f"{API}/datasets/upload/{session_id}")

    def cancel_dataset_upload(self, session_id: str) -> dict[str, Any]:
        """POST /datasets/upload/{session_id}/cancel."""
        return self._request("POST", f"{API}/datasets/upload/{session_id}/cancel")

    def _put_file(self, put_url: str, file_path: str) -> None:
        """PUT one file to its presigned S3 URL. S3 rejects the upload without the
        server-side-encryption header, so it is mandatory here."""
        with open(file_path, "rb") as f:
            try:
                with httpx.Client(timeout=httpx.Timeout(None, connect=10.0)) as client:
                    resp = client.put(
                        put_url,
                        content=f,
                        headers={"x-amz-server-side-encryption": "AES256"},
                    )
            except httpx.RequestError as exc:
                raise NoriBackendError(
                    f"S3 PUT failed for {file_path}: {exc}", status_code=502
                ) from exc
        if not resp.is_success:
            raise NoriBackendError(
                f"S3 PUT for {file_path} -> {resp.status_code}: {resp.text[:200]}",
                status_code=resp.status_code,
            )

    def upload_dataset(
        self,
        local_path: str,
        commit_message: str | None = None,
        poll_interval: float = 5.0,
        poll_timeout: float = 1800.0,
    ) -> dict[str, Any]:
        """Full 4-step upload: build+validate manifest -> start -> PUT each file to S3 ->
        finalize (retry HEAD-miss) -> poll until terminal. Returns the final SessionRow.

        Raises ManifestError on a bad dataset dir, NoriBackendError on backend/S3/timeout.
        """
        manifest = build_manifest(local_path)
        validate_manifest(manifest)

        start = self.start_dataset_upload(manifest, commit_message=commit_message)
        session_id = start["session_id"]
        # path -> presigned PUT URL
        put_urls = {u["path"]: u["put_url"] for u in start.get("uploads", [])}
        root = Path(local_path)

        def put_paths(paths: list[str]) -> None:
            for rel in paths:
                url = put_urls.get(rel)
                if not url:
                    raise NoriBackendError(
                        f"No presigned URL returned for {rel!r}", status_code=500
                    )
                self._put_file(url, str(root / rel))

        put_paths([entry["path"] for entry in manifest])

        # Finalize; on a 422 HEAD-miss, re-PUT the listed paths and finalize once more.
        try:
            self.finalize_dataset_upload(session_id, commit_message=commit_message)
        except NoriBackendError as exc:
            missing = exc.detail.get("missing") if isinstance(exc.detail, dict) else None
            if exc.status_code == 422 and missing:
                logger.warning("Finalize HEAD-miss; retrying %d file(s)", len(missing))
                put_paths(list(missing))
                self.finalize_dataset_upload(session_id, commit_message=commit_message)
            else:
                raise

        # Poll until terminal.
        deadline = time.monotonic() + poll_timeout
        while True:
            session = self.get_dataset_upload(session_id)
            status = session.get("status")
            if status in UPLOAD_TERMINAL_STATES:
                if status != UPLOAD_SUCCESS_STATE:
                    raise NoriBackendError(
                        f"Upload {session_id} ended in {status}: "
                        f"{session.get('failure_reason')}",
                        status_code=502,
                        detail=session,
                    )
                return session
            if time.monotonic() >= deadline:
                raise NoriBackendError(
                    f"Upload {session_id} still {status} after {poll_timeout}s",
                    status_code=504,
                    detail=session,
                )
            time.sleep(poll_interval)

    # -- consents (Phase 6) --------------------------------------------------------

    def list_consents(self) -> Any:
        """GET /consents (active + revoked)."""
        return self._request("GET", f"{API}/consents")

    def grant_consent(
        self,
        consent_type: str,
        policy_version: str,
        scope_dataset_repo: str | None = None,
    ) -> dict[str, Any]:
        """POST /consents — grant train_self / publish_public. Idempotent on
        (customer, type, scope)."""
        body: dict[str, Any] = {
            "consent_type": consent_type,
            "policy_version": policy_version,
        }
        if scope_dataset_repo is not None:
            body["scope_dataset_repo"] = scope_dataset_repo
        return self._request("POST", f"{API}/consents", json=body)

    def revoke_consent(self, consent_id: str, reason: str | None = None) -> dict[str, Any]:
        """POST /consents/{id}/revoke."""
        body = {"reason": reason} if reason is not None else None
        return self._request("POST", f"{API}/consents/{consent_id}/revoke", json=body)

    # -- deletion requests (Phase 6) -----------------------------------------------

    def create_deletion_request(self, payload: dict[str, Any]) -> dict[str, Any]:
        """POST /deletion-requests (backend purge sweeper not yet wired — status row only)."""
        return self._request("POST", f"{API}/deletion-requests", json=payload)


# -- dataset manifest helpers (module-level so they're unit-testable w/o a client) -----


def build_manifest(local_path: str) -> list[dict[str, Any]]:
    """Walk a dataset dir and produce the upload manifest: [{path, size}, ...] with
    POSIX-style relative paths, sorted for determinism. Skips empty dirs (no entries)."""
    root = Path(local_path)
    if not root.is_dir():
        raise ManifestError(f"Dataset path is not a directory: {local_path}")
    manifest: list[dict[str, Any]] = []
    for p in sorted(root.rglob("*")):
        if p.is_file():
            manifest.append(
                {"path": p.relative_to(root).as_posix(), "size": p.stat().st_size}
            )
    return manifest


def validate_manifest(manifest: list[dict[str, Any]]) -> None:
    """Enforce the manifest rules client-side; raise ManifestError on the first violation.

    Rules (mirror the backend): non-empty; relative paths only (no `..`/absolute);
    extension allowlist; <=5 GB/file; <=20 GB total; must contain info.json.
    """
    if not manifest:
        raise ManifestError("Dataset is empty — nothing to upload.")

    total = 0
    names = {entry["path"] for entry in manifest}
    for entry in manifest:
        rel, size = entry["path"], entry["size"]
        if rel.startswith("/") or ".." in Path(rel).parts:
            raise ManifestError(f"Unsafe path in manifest: {rel!r}")
        ext = Path(rel).suffix.lower()
        if ext not in UPLOAD_ALLOWED_EXTENSIONS:
            raise ManifestError(
                f"Disallowed file type {ext!r} ({rel}); allowed: "
                f"{sorted(UPLOAD_ALLOWED_EXTENSIONS)}"
            )
        if size > UPLOAD_MAX_FILE_BYTES:
            raise ManifestError(f"{rel} is {size} bytes (> {UPLOAD_MAX_FILE_BYTES} limit).")
        total += size

    if total > UPLOAD_MAX_TOTAL_BYTES:
        raise ManifestError(f"Dataset is {total} bytes (> {UPLOAD_MAX_TOTAL_BYTES} limit).")
    if not any(Path(n).name == UPLOAD_REQUIRED_FILE for n in names):
        raise ManifestError(f"Dataset must contain {UPLOAD_REQUIRED_FILE}.")
