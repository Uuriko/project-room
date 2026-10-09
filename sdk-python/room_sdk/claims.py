"""Work-claim board operations.

Endpoint map (docs/openapi.yaml)::

    GET  /api/rooms/{roomId}/work-claims-read
    POST /api/rooms/{roomId}/work-claims
    GET  /api/rooms/{roomId}/work-claims/{claimId}
    POST /api/rooms/{roomId}/work-claims/{claimId}/claim
    POST /api/rooms/{roomId}/work-claims/{claimId}/update
    GET  /api/rooms/{roomId}/work-claims/config
    GET  /api/rooms/{roomId}/work-claims/status
    POST /api/rooms/{roomId}/work-claims/sweep
"""

from __future__ import annotations

from typing import Any, Dict, Iterator, List, Optional

from .models import ClaimConfig, ClaimPage, WorkClaim

# Claim states accepted by the /update endpoint (``unclaimed`` releases).
CLAIM_STATES = ("claimed", "in_progress", "blocked", "done", "unclaimed")

# Read filters accepted by /work-claims-read.
CLAIM_READ_STATES = ("unclaimed", "claimed", "in_progress", "blocked", "done", "closed")
CLAIM_READ_QUEUES = ("ready",)


class ClaimsMixin:
    """Work-claim methods; mixed into :class:`RoomClient`."""

    # -- reads ----------------------------------------------------------

    def list_claims(
        self,
        *,
        room_id: Optional[str] = None,
        state: Optional[str] = None,
        queue: Optional[str] = None,
        limit: int = 50,
        cursor: Optional[str] = None,
        view: Optional[str] = None,
    ) -> ClaimPage:
        """Read one page of the room's work-claim board.

        ``state`` and ``queue`` are mutually exclusive (the server 422s
        otherwise); ``queue`` may only be ``"ready"``.
        """
        if state and queue:
            raise ValueError("state and queue cannot be combined")
        if state and state not in CLAIM_READ_STATES:
            raise ValueError(f"unknown claim state filter: {state!r}")
        if queue and queue not in CLAIM_READ_QUEUES:
            raise ValueError(f"unknown claim queue filter: {queue!r}")
        payload = self._get(  # type: ignore[attr-defined]
            f"/api/rooms/{self._room_id(room_id)}/work-claims-read",  # type: ignore[attr-defined]
            query={"state": state, "queue": queue, "limit": limit,
                   "cursor": cursor, "view": view},
        )
        return ClaimPage.from_dict(payload)

    def iter_claims(self, **kwargs: Any) -> Iterator[WorkClaim]:
        """Yield every claim across pages (follows ``nextCursor``)."""
        cursor: Optional[str] = kwargs.pop("cursor", None)
        while True:
            page = self.list_claims(cursor=cursor, **kwargs)
            yield from page.claims
            cursor = page.next_cursor
            if not cursor:
                return

    def get_claim(self, claim_id: str, *, room_id: Optional[str] = None) -> WorkClaim:
        """Read one claim by id."""
        payload = self._get(  # type: ignore[attr-defined]
            f"/api/rooms/{self._room_id(room_id)}/work-claims/{claim_id}",  # type: ignore[attr-defined]
        )
        return WorkClaim.from_dict(payload)

    def get_claims_config(self, *, room_id: Optional[str] = None) -> ClaimConfig:
        """Read the room's work-claim caps (open-claim cap, lease defaults)."""
        payload = self._get(  # type: ignore[attr-defined]
            f"/api/rooms/{self._room_id(room_id)}/work-claims/config",  # type: ignore[attr-defined]
        )
        return ClaimConfig.from_dict(payload)

    def get_claims_status(self, *, room_id: Optional[str] = None) -> Dict[str, Any]:
        """Read the board status summary."""
        return self._get(  # type: ignore[attr-defined]
            f"/api/rooms/{self._room_id(room_id)}/work-claims/status",  # type: ignore[attr-defined]
        )

    # -- writes ---------------------------------------------------------

    def create_claim(
        self,
        *,
        room_id: Optional[str] = None,
        claim_id: Optional[str] = None,
        title: Optional[str] = None,
        note: Optional[str] = None,
        files: Optional[List[str]] = None,
        tags: Optional[List[str]] = None,
        depends_on: Optional[List[str]] = None,
        parent_claim_id: Optional[str] = None,
        evidence_refs: Optional[List[str]] = None,
        pull_request: Optional[str] = None,
        review_policy: Optional[str] = None,
    ) -> WorkClaim:
        """Create an unclaimed work-claim item.

        If ``claim_id`` is supplied it is used as the idempotency key for
        the create (a duplicate with identical input returns the item).
        """
        body: Dict[str, Any] = {
            "id": claim_id, "title": title, "note": note, "files": files,
            "tags": tags, "dependsOn": depends_on,
            "parentClaimId": parent_claim_id, "evidenceRefs": evidence_refs,
            "pullRequest": pull_request, "reviewPolicy": review_policy,
        }
        payload = self._post(  # type: ignore[attr-defined]
            f"/api/rooms/{self._room_id(room_id)}/work-claims",  # type: ignore[attr-defined]
            body={k: v for k, v in body.items() if v is not None},
        )
        return WorkClaim.from_dict(payload)

    def claim(
        self,
        claim_id: str,
        *,
        room_id: Optional[str] = None,
        note: Optional[str] = None,
        lease_hours: Optional[float] = None,
        files: Optional[List[str]] = None,
        advisory: bool = False,
        depends_on: Optional[List[str]] = None,
        parent_claim_id: Optional[str] = None,
        evidence_refs: Optional[List[str]] = None,
        pull_request: Optional[str] = None,
    ) -> WorkClaim:
        """Claim an unclaimed item for the calling member.

        An already-claimed item raises :class:`ConflictError` with code
        ``work_claim_conflict`` (the message names the holder) or
        ``file_lease_conflict`` when declared files overlap a live lease.
        """
        body: Dict[str, Any] = {
            "note": note, "leaseHours": lease_hours, "files": files,
            "advisory": advisory or None, "dependsOn": depends_on,
            "parentClaimId": parent_claim_id, "evidenceRefs": evidence_refs,
            "pullRequest": pull_request,
        }
        payload = self._post(  # type: ignore[attr-defined]
            f"/api/rooms/{self._room_id(room_id)}/work-claims/{claim_id}/claim",  # type: ignore[attr-defined]
            body={k: v for k, v in body.items() if v is not None},
        )
        return WorkClaim.from_dict(payload)

    def update_claim(
        self,
        claim_id: str,
        *,
        room_id: Optional[str] = None,
        state: Optional[str] = None,
        note: Optional[str] = None,
        delivery_mode: Optional[str] = None,
        reviewed_by: Optional[str] = None,
        tags: Optional[List[str]] = None,
        blobs: Optional[List[str]] = None,
        parent_claim_id: Optional[str] = None,
        evidence_refs: Optional[List[str]] = None,
        expected_claimed_at: Optional[str] = None,
        expected_history_length: Optional[int] = None,
    ) -> WorkClaim:
        """Owner-only update of a claimed item.

        ``state="unclaimed"`` releases the claim; ``state="done"`` closes it
        (accepts ``delivery_mode``, ``reviewed_by``, ``tags``, ``blobs``).
        Pass ``expected_claimed_at`` + ``expected_history_length`` from a
        fresh read to make the write fail closed on concurrent changes
        (409 ``work_claim_conflict`` instead of silent clobbering).
        """
        if state and state not in CLAIM_STATES:
            raise ValueError(f"unknown claim state: {state!r}")
        if (delivery_mode or reviewed_by or tags or blobs) and state != "done":
            raise ValueError("delivery_mode/reviewed_by/tags/blobs require state='done'")
        body: Dict[str, Any] = {
            "state": state, "note": note, "deliveryMode": delivery_mode,
            "reviewedBy": reviewed_by, "tags": tags, "blobs": blobs,
            "parentClaimId": parent_claim_id, "evidenceRefs": evidence_refs,
            "expectedClaimedAt": expected_claimed_at,
            "expectedHistoryLength": expected_history_length,
        }
        payload = self._post(  # type: ignore[attr-defined]
            f"/api/rooms/{self._room_id(room_id)}/work-claims/{claim_id}/update",  # type: ignore[attr-defined]
            body={k: v for k, v in body.items() if v is not None},
        )
        return WorkClaim.from_dict(payload)

    def release_claim(self, claim_id: str, **kwargs: Any) -> WorkClaim:
        """Release a claim you hold (state -> ``unclaimed``)."""
        return self.update_claim(claim_id, state="unclaimed", **kwargs)

    def append_pull_request(
        self,
        claim_id: str,
        pr_url: str,
        *,
        room_id: Optional[str] = None,
        expected_claimed_at: str,
        expected_history_length: int,
    ) -> WorkClaim:
        """Append a PR link to a claim (owner-only, round-preconditioned)."""
        payload = self._post(  # type: ignore[attr-defined]
            f"/api/rooms/{self._room_id(room_id)}/work-claims/{claim_id}/update",  # type: ignore[attr-defined]
            body={
                "appendPullRequest": pr_url,
                "expectedClaimedAt": expected_claimed_at,
                "expectedHistoryLength": expected_history_length,
            },
        )
        return WorkClaim.from_dict(payload)

    def sweep_claims(self, *, room_id: Optional[str] = None) -> Dict[str, Any]:
        """Release expired claim leases (server also sweeps lazily)."""
        return self._post(  # type: ignore[attr-defined]
            f"/api/rooms/{self._room_id(room_id)}/work-claims/sweep",  # type: ignore[attr-defined]
        )
