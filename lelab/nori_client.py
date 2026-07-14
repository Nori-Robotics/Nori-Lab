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

import hashlib
import logging
import os
import re
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

# Policy-bundle member names we will write to disk. The backend's manifest is
# trusted for CONTENT (it hashes the sanitized bytes), but never for PATHS:
# a name is used only as a bare filename inside the destination dir, and must
# look like one. Mirrors the backend's sanitize.py allowlist discipline.
_BUNDLE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _safe_bundle_name(name: str) -> bool:
    """True iff `name` is a plain filename: no separators, no traversal, no
    leading dot, sane charset. Defense-in-depth — the backend already
    allowlists names at promotion; this keeps a compromised/buggy backend from
    turning an install into an arbitrary file write."""
    return (
        bool(name)
        and len(name) <= 255
        and "/" not in name
        and "\\" not in name
        and ".." not in name
        and bool(_BUNDLE_NAME_RE.match(name))
    )


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
        timeout: httpx.Timeout | None = None,
    ) -> Any:
        """Issue a request and return parsed JSON, raising NoriBackendError on non-2xx."""
        url = f"{self.base_url}{path}"
        try:
            with httpx.Client(timeout=timeout or DEFAULT_TIMEOUT) as client:
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
        """POST /customers/me/pair — pair a robot (multi-robot). First robot becomes
        active; idempotent on an owned serial; 409 only if another customer owns it."""
        return self._request(
            "POST", f"{API}/customers/me/pair", json={"robot_serial_number": robot_serial_number}
        )

    def unpair_robot(self, robot_serial_number: str | None = None) -> dict[str, Any]:
        """POST /customers/me/unpair — detach a robot; idempotent if already unpaired.

        Pass a serial to unpair a specific robot (multi-robot); omit for the sole/active one.
        NOTE: the Nori-Backend endpoint is not built yet (tracked in Nori-Backend/todos.md);
        until it ships this returns the backend's 404/405.
        """
        json = {"robot_serial_number": robot_serial_number} if robot_serial_number else None
        return self._request("POST", f"{API}/customers/me/unpair", json=json)

    def list_robots(self) -> Any:
        """GET /customers/me/robots — all robots paired to the customer (multi-robot).

        NOTE: not built in Nori-Backend yet (tracked in Nori-Backend/todos.md).
        """
        return self._request("GET", f"{API}/customers/me/robots")

    def select_robot(self, robot_serial_number: str) -> dict[str, Any]:
        """POST /customers/me/robots/{serial}/select — set the active robot.

        NOTE: not built in Nori-Backend yet (tracked in Nori-Backend/todos.md).
        """
        from urllib.parse import quote

        return self._request(
            "POST", f"{API}/customers/me/robots/{quote(robot_serial_number, safe='')}/select"
        )

    # -- marketplace (Phase 3) -----------------------------------------------------

    def list_policies(self, source: PolicySource | None = None) -> Any:
        """GET /marketplace/policies (?source=own|first_party|community)."""
        params = {"source": source} if source else None
        return self._request("GET", f"{API}/marketplace/policies", params=params)

    def acquire_policy(self, listing_id: str) -> dict[str, Any]:
        """POST /marketplace/policies/{listing_id}/acquire."""
        return self._request("POST", f"{API}/marketplace/policies/{listing_id}/acquire")

    def get_policy_details(self, ref: str) -> dict[str, Any]:
        """GET /marketplace/policies/{ref} — full detail view (source, class,
        provenance, file manifest, editable flag)."""
        return self._request("GET", f"{API}/marketplace/policies/{ref}")

    def rename_policy(self, ref: str, title: str | None) -> dict[str, Any]:
        """PATCH /marketplace/policies/{ref} — set/clear an own policy's title.
        Backend PII-scans the title (422 on disallowed content) and 404s on a
        non-own ref. Returns the updated detail view."""
        return self._request(
            "PATCH", f"{API}/marketplace/policies/{ref}", json={"title": title}
        )

    def publish_policy(self, ref: str, title: str, description: str | None = None) -> dict[str, Any]:
        """POST /marketplace/policies/{ref}/publish — request community
        publication of an OWN policy. Creates a pending_review listing (NOT
        public yet — re-homing + human review follow); poll list_my_listings
        for the outcome. 403 without publish_public consent, 409 for an
        already-active listing / in-flight deletion / pre-bundle legacy job."""
        return self._request(
            "POST", f"{API}/marketplace/policies/{ref}/publish",
            json={"title": title, "description": description},
        )

    def unpublish_policy(self, ref: str) -> dict[str, Any]:
        """DELETE /marketplace/policies/{ref}/publish — instant, idempotent
        takedown of the caller's active listing for this job (revokes derived
        acquisitions; the row is kept for audit)."""
        return self._request("DELETE", f"{API}/marketplace/policies/{ref}/publish")

    def list_my_listings(self) -> Any:
        """GET /marketplace/my-listings — the caller's community submissions in
        every lifecycle state (pending_review/public/rejected/taken_down)."""
        return self._request("GET", f"{API}/marketplace/my-listings")

    def list_public_datasets(self) -> Any:
        """GET /marketplace/datasets/public (auth-optional)."""
        return self._request("GET", f"{API}/marketplace/datasets/public")

    def list_my_datasets(self) -> Any:
        """GET /datasets/upload — the caller's promoted datasets (training
        dataset picker). Each entry: {dataset_ref, label, created_at, session_id}."""
        return self._request("GET", f"{API}/datasets/upload")

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

    def get_policy_manifest(self, ref: str) -> dict[str, Any]:
        """GET /marketplace/policies/{ref}/manifest — the policy's runnable file
        set: {files: [{name, size_bytes, sha256}]}. sha256/size are null on
        legacy single-file promotions."""
        return self._request("GET", f"{API}/marketplace/policies/{ref}/manifest")

    def download_policy_bundle(self, ref: str, dest_dir: str) -> dict[str, Any]:
        """Download a policy's FULL runnable bundle into `dest_dir`.

        Fetches /manifest, then streams each file from /files/{name}, verifying
        the bytes against the manifest sha256 (when recorded) BEFORE the atomic
        rename — a corrupt or tampered file never lands under its final name.
        Mirrors `upload_dataset`'s manifest-then-per-file loop, downstream.

        Returns {ref, path, size_bytes, files} where `path` is the model file
        (backward-compatible with download_policy's result shape) and `files`
        lists every installed member. Raises NoriBackendError on any backend,
        integrity, or unsafe-name failure; on failure no partial .part files
        are left behind (completed earlier members may remain — reinstall
        overwrites them atomically).
        """
        manifest = self.get_policy_manifest(ref)
        entries = manifest.get("files") or []
        if not entries:
            raise NoriBackendError(
                f"policy {ref} manifest is empty", status_code=502, detail=manifest
            )

        os.makedirs(dest_dir, exist_ok=True)
        installed: list[dict[str, Any]] = []
        model_path: str | None = None

        for entry in entries:
            name = entry.get("name") or ""
            if not _safe_bundle_name(name):
                raise NoriBackendError(
                    f"manifest contains unsafe file name {name!r}", status_code=502
                )
            final_path = os.path.join(dest_dir, name)
            tmp_path = f"{final_path}.part"
            url = f"{self.base_url}{API}/marketplace/policies/{ref}/files/{name}"
            digest = hashlib.sha256()
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
                            digest.update(chunk)
                            size += len(chunk)

                expected = entry.get("sha256")
                if expected and digest.hexdigest() != expected:
                    raise NoriBackendError(
                        f"integrity failure for {name}: bytes do not match the "
                        f"promotion-time sha256 — not installing",
                        status_code=502,
                    )
                expected_size = entry.get("size_bytes")
                if expected_size is not None and size != expected_size:
                    raise NoriBackendError(
                        f"size mismatch for {name}: got {size}, manifest says "
                        f"{expected_size} — not installing",
                        status_code=502,
                    )
                os.replace(tmp_path, final_path)
            except httpx.RequestError as exc:
                raise NoriBackendError(
                    f"Could not reach Nori-Backend at {url}: {exc}", status_code=502
                ) from exc
            finally:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)

            installed.append({"name": name, "size_bytes": size, "sha256": digest.hexdigest()})
            if name == "model.safetensors":
                model_path = final_path

        if model_path is None:
            raise NoriBackendError(
                f"policy {ref} bundle has no model.safetensors", status_code=502
            )
        total = sum(f["size_bytes"] for f in installed)
        return {"ref": ref, "path": model_path, "size_bytes": total, "files": installed}

    # -- training (Phase 4 dispatch + log polling) ---------------------------------

    def dispatch_training(self, body: dict[str, Any]) -> dict[str, Any]:
        """POST /training/dispatch — the DispatchRequest body.

        `body` must include `timeout_seconds`; it may also carry the honored
        training config (policy_type, steps, batch_size, num_workers, seed,
        policy_use_amp, log_freq, dataset_ref). The backend validates + clamps
        and ignores any field it doesn't consume (forward-compatible).

        Returns {internal_job_uuid, hf_job_id, ...}.
        """
        return self._request("POST", f"{API}/training/dispatch", json=body)

    def stop_job(self, job_id: str) -> dict[str, Any]:
        """POST /training/jobs/{id}/stop — request a safe pause (the
        container checkpoints and the job lands PAUSED, resumable later)."""
        return self._request("POST", f"{API}/training/jobs/{job_id}/stop")

    def get_estimate_params(self) -> dict[str, Any]:
        """GET /training/estimate-params — per-policy steps/s + setup seconds +
        tier max duration + the pause/resume capability flag. Constants for
        client-side time estimates; same numbers the dispatch fit-gate uses."""
        return self._request("GET", f"{API}/training/estimate-params")

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
        self,
        manifest: list[dict[str, Any]],
        commit_message: str | None = None,
        label: str | None = None,
    ) -> dict[str, Any]:
        """POST /datasets/upload/start — manifest [{path, size}, ...].

        `label` is the human-readable dataset name shown in the training
        picker (backend migration 021; older backends ignore the field).

        Returns {session_id, uploads: [{path, put_url}], expires_at}.
        """
        body: dict[str, Any] = {"manifest": manifest}
        if commit_message is not None:
            body["commit_message"] = commit_message
        if label is not None:
            body["label"] = label[:120]
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
        label: str | None = None,
    ) -> dict[str, Any]:
        """Full 4-step upload: build+validate manifest -> start -> PUT each file to S3 ->
        finalize (retry HEAD-miss) -> poll until terminal. Returns the final SessionRow.

        Raises ManifestError on a bad dataset dir, NoriBackendError on backend/S3/timeout.
        """
        manifest = build_manifest(local_path)
        validate_manifest(manifest)

        # Default the cloud-side name to the local dataset's directory name —
        # the name given at record time / via rename, so the training picker
        # shows "pick_place_mugs", not "Upload <date>".
        if label is None:
            label = Path(local_path).name
        start = self.start_dataset_upload(manifest, commit_message=commit_message, label=label)
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
        """POST /deletion-requests — the backend worker's `deletions` surface performs
        the erasure (S3/HF/checkpoint teardown, + account + Auth-user for `full`)."""
        return self._request("POST", f"{API}/deletion-requests", json=payload)

    # -- billing ---------------------------------------------------------------

    def get_billing_summary(self) -> dict[str, Any]:
        """GET /billing/summary — tier, monthly compute usage, and agent-token
        budgets in one read-only call. Backs the account page's Billing panel.

        Returns {billing_tier, tier_price_usd_per_month, compute: {...seconds,
        monthly}, agent_tokens: {used_today/allowed_today/used_this_month/
        allowed_per_month/hard_capped}, limits: {...}|null}. Monthly fields are
        null until backend migration 013 is applied.
        """
        return self._request("GET", f"{API}/billing/summary")

    # -- agent (LLM) token metering (cost governance) ------------------------------

    def get_agent_usage(self) -> dict[str, Any]:
        """GET /agent/usage — the customer's current daily agent-token budget.

        Returns {used_today, allowed_today, remaining_today, all_time_tokens,
        soft_warn_threshold, soft_warning, hard_capped}. Cheap, non-mutating; the
        pre-turn gate blocks a new turn when `hard_capped` is true.
        """
        return self._request("GET", f"{API}/agent/usage")

    def charge_agent_usage(
        self,
        model: str,
        input_tokens: int,
        output_tokens: int,
        cache_read_tokens: int = 0,
        cache_write_tokens: int = 0,
        new_run: bool = False,
    ) -> dict[str, Any]:
        """POST /agent/usage/charge — record ONE turn's actual token usage and get the
        updated budget snapshot back. Additive: call exactly once per turn (retrying
        double-counts). `new_run` marks the first turn of a new agent run (for run_count)."""
        return self._request(
            "POST",
            f"{API}/agent/usage/charge",
            json={
                "model": model,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_read_tokens": cache_read_tokens,
                "cache_write_tokens": cache_write_tokens,
                "new_run": new_run,
            },
        )

    # -- LLM gateway (the ANTHROPIC key lives ONLY on the backend) ------------------

    @staticmethod
    def _llm_body(
        model: str,
        max_tokens: int,
        messages: list[dict[str, Any]],
        system: str | None,
        tools: list[dict[str, Any]] | None,
        new_run: bool,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "messages": messages}
        if system is not None:
            body["system"] = system
        if tools is not None:
            body["tools"] = tools
        body["new_run"] = new_run
        return body

    def llm_messages(
        self,
        *,
        model: str,
        max_tokens: int,
        messages: list[dict[str, Any]],
        system: str | None = None,
        tools: list[dict[str, Any]] | None = None,
        new_run: bool = False,
    ) -> dict[str, Any]:
        """POST /agent/llm/messages — the gated, metered Anthropic proxy. The backend holds
        the key, checks the daily budget (429 if capped), calls Claude, charges the turn, and
        returns {stop_reason, content[], usage, budget}. Longer timeout than the default: a
        1500-token completion (possibly with an image) routinely exceeds 30s."""
        return self._request(
            "POST",
            f"{API}/agent/llm/messages",
            json=self._llm_body(model, max_tokens, messages, system, tools, new_run),
            timeout=httpx.Timeout(120.0, connect=10.0),
        )

    def llm_messages_stream(
        self,
        *,
        model: str,
        max_tokens: int,
        messages: list[dict[str, Any]],
        system: str | None = None,
        tools: list[dict[str, Any]] | None = None,
        new_run: bool = False,
    ):
        """POST /agent/llm/messages/stream — same gate/charge, but yields the model's TEXT in
        chunks (the backend charges on stream completion). A non-2xx (429/503) is read and
        raised as NoriBackendError BEFORE any text is yielded, so the caller can turn it into
        the right pre-flight HTTP error just like the non-streaming path."""
        url = f"{self.base_url}{API}/agent/llm/messages/stream"
        body = self._llm_body(model, max_tokens, messages, system, tools, new_run)
        try:
            with (
                httpx.Client(timeout=httpx.Timeout(120.0, connect=10.0)) as client,
                client.stream("POST", url, json=body, headers=self._headers()) as resp,
            ):
                if not resp.is_success:
                    resp.read()  # must drain before accessing .text on a stream response
                    detail: Any = None
                    try:
                        parsed = resp.json()
                        detail = parsed.get("detail", parsed) if isinstance(parsed, dict) else parsed
                    except ValueError:
                        detail = resp.text or None
                    raise NoriBackendError(
                        f"POST {API}/agent/llm/messages/stream -> {resp.status_code}: {detail}",
                        status_code=resp.status_code,
                        detail=detail,
                    )
                for chunk in resp.iter_text():
                    if chunk:
                        yield chunk
        except httpx.RequestError as exc:
            raise NoriBackendError(
                f"Could not reach Nori-Backend at {url}: {exc}", status_code=502
            ) from exc


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
