"""Error taxonomy for the Project Room Python SDK.

Mirrors docs/ERROR-TAXONOMY.md: every API error has the shape::

    {"error": {"code": "...", "message": "..."}, "status": "...",
     "reason": "...", "hint": "...", "next": [...]}

``error.code`` is the stable machine-readable code. The coarse category is
derived from the HTTP status, not from the code string.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


class RoomError(Exception):
    """Base class for every SDK error.

    Attributes:
        code: stable machine-readable error code (e.g. ``work_claim_conflict``),
            or ``None`` when the server returned no structured body.
        http_status: the HTTP status that produced this error.
        message: human-readable detail from the server (may be ``None``).
        hint: one line of what to do (may be ``None``).
        next: concrete next steps suggested by the server (tools, paths...).
        retry_after: seconds from the ``Retry-After`` header when present.
    """

    def __init__(
        self,
        message: Optional[str] = None,
        *,
        code: Optional[str] = None,
        http_status: Optional[int] = None,
        hint: Optional[str] = None,
        next: Optional[List[Any]] = None,
        retry_after: Optional[float] = None,
    ) -> None:
        self.code = code
        self.http_status = http_status
        self.hint = hint
        self.next: List[Any] = list(next or [])
        self.retry_after = retry_after
        super().__init__(message or code or "room request failed")

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        parts = [f"code={self.code}"] if self.code else []
        if self.http_status is not None:
            parts.append(f"http={self.http_status}")
        if self.hint:
            parts.append(f"hint={self.hint}")
        detail = super().__str__()
        return f"{detail} ({'; '.join(parts)})" if parts else detail

    @property
    def is_retryable(self) -> bool:
        """True when a retry with the *exact same* request is sanctioned.

        409 conflicts are deliberately NOT retryable with the same input:
        re-read state first.
        """
        return isinstance(self, (RateLimitedError, UnavailableError))


class AuthenticationError(RoomError):
    """401 — bad, missing or expired credential."""


class ForbiddenError(RoomError):
    """403 — this credential may not do that."""


class NotFoundError(RoomError):
    """404 — room, claim, invitation or cursor does not exist (or is hidden)."""


class ConflictError(RoomError):
    """409 — the world moved.

    Never silently retry the same input. Re-read state first. Covers
    ``work_claim_conflict``, ``file_lease_conflict``, ``idempotency_conflict``,
    the ``already_*`` family and ``stale_*_revision``.
    """


class ValidationError(RoomError):
    """422 — fields refused: bad shape, bad enum, over limits."""


class RateLimitedError(RoomError):
    """429 — too fast. Wait for ``Retry-After``, retry the exact request."""


class UnavailableError(RoomError):
    """503 — maintenance or storage_unavailable. Wait, retry the exact
    request, reconcile afterward. Never "check access" for these."""


class ServerError(RoomError):
    """Other 5xx — server error; nothing is claimed. Reconcile or retry."""


class TransportError(RoomError):
    """The HTTP transport itself failed (DNS, refused connection, timeout)."""


def error_from_response(
    http_status: int,
    payload: Optional[Dict[str, Any]] = None,
    *,
    retry_after: Optional[float] = None,
) -> RoomError:
    """Build the right RoomError subclass from an HTTP status + error body.

    Understands the room's ``{"error": {"code", "message"}, "hint", "next"}``
    shape, and falls back to a status-only error for bare responses.
    """
    payload = payload or {}
    err = payload.get("error") if isinstance(payload.get("error"), dict) else {}
    code = err.get("code")
    message = err.get("message")
    hint = payload.get("hint")
    nxt = payload.get("next")
    if not isinstance(nxt, list):
        nxt = []

    cls = {
        401: AuthenticationError,
        403: ForbiddenError,
        404: NotFoundError,
        409: ConflictError,
        422: ValidationError,
        429: RateLimitedError,
        503: UnavailableError,
    }.get(http_status, ServerError if http_status >= 500 else RoomError)
    return cls(
        message,
        code=code,
        http_status=http_status,
        hint=hint,
        next=nxt,
        retry_after=retry_after,
    )
