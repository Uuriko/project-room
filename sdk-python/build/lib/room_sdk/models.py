"""Typed models for the Project Room public API.

Every model is a plain ``dataclass`` with a ``from_dict`` constructor that
tolerates unknown extra fields (the server is additive; the SDK must not
crash on fields it does not know yet).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


def _opt_str(d: Dict[str, Any], key: str) -> Optional[str]:
    v = d.get(key)
    return v if isinstance(v, str) else None


def _opt_int(d: Dict[str, Any], key: str) -> Optional[int]:
    v = d.get(key)
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _opt_list(d: Dict[str, Any], key: str) -> List[Any]:
    v = d.get(key)
    return list(v) if isinstance(v, list) else []


# --------------------------------------------------------------------------
# Claims
# --------------------------------------------------------------------------

@dataclass
class WorkClaim:
    """One item on the room's work-claim board.

    ``raw`` keeps the full server payload so callers can reach fields the
    SDK does not model yet.
    """

    id: str
    room_id: Optional[str] = None
    title: Optional[str] = None
    note: Optional[str] = None
    state: Optional[str] = None
    owner: Optional[str] = None
    claimed_at: Optional[str] = None
    lease_expires_at: Optional[str] = None
    files: List[str] = field(default_factory=list)
    depends_on: List[str] = field(default_factory=list)
    tags: List[str] = field(default_factory=list)
    revision: Optional[str] = None
    history_length: Optional[int] = None
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "WorkClaim":
        history = d.get("history")
        return cls(
            id=str(d.get("id", "")),
            room_id=_opt_str(d, "roomId"),
            title=_opt_str(d, "title"),
            note=_opt_str(d, "note"),
            state=_opt_str(d, "state"),
            owner=_opt_str(d, "owner"),
            claimed_at=_opt_str(d, "claimedAt"),
            lease_expires_at=_opt_str(d, "leaseExpiresAt"),
            files=[f for f in _opt_list(d, "files") if isinstance(f, str)],
            depends_on=[x for x in _opt_list(d, "dependsOn") if isinstance(x, str)],
            tags=[t for t in _opt_list(d, "tags") if isinstance(t, str)],
            revision=_opt_str(d, "revision"),
            history_length=(len(history) + int(d.get("historyOmitted") or 0))
            if isinstance(history, list)
            else None,
            raw=dict(d),
        )


@dataclass
class ClaimPage:
    """One page from ``GET /api/rooms/{roomId}/work-claims-read``."""

    room_id: Optional[str]
    claims: List[WorkClaim]
    next_cursor: Optional[str]
    evaluated_at: Optional[str]
    consistency: Optional[str]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ClaimPage":
        items = d.get("claims")
        return cls(
            room_id=_opt_str(d, "roomId"),
            claims=[WorkClaim.from_dict(c) for c in items] if isinstance(items, list) else [],
            next_cursor=_opt_str(d, "nextCursor"),
            evaluated_at=_opt_str(d, "evaluatedAt"),
            consistency=_opt_str(d, "consistency"),
        )


@dataclass
class ClaimConfig:
    """Room work-claim caps from ``GET .../work-claims/config``."""

    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ClaimConfig":
        return cls(raw=dict(d))


# --------------------------------------------------------------------------
# Events
# --------------------------------------------------------------------------

@dataclass
class RoomEvent:
    """One entry of the room event log."""

    id: Optional[str]
    sequence: Optional[int]
    type: Optional[str]
    actor_id: Optional[str]
    at: Optional[str]
    data: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "RoomEvent":
        data = d.get("data")
        return cls(
            id=_opt_str(d, "id"),
            sequence=_opt_int(d, "sequence"),
            type=_opt_str(d, "type"),
            actor_id=_opt_str(d, "actorId"),
            at=_opt_str(d, "at"),
            data=dict(data) if isinstance(data, dict) else {},
        )


@dataclass
class EventPage:
    """One page from ``GET /api/rooms/{roomId}/events``."""

    events: List[RoomEvent]
    next: Optional[int]
    has_more: bool = False

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "EventPage":
        items = d.get("events")
        return cls(
            events=[RoomEvent.from_dict(e) for e in items] if isinstance(items, list) else [],
            next=_opt_int(d, "next"),
            has_more=bool(d.get("hasMore")),
        )


# --------------------------------------------------------------------------
# Room posts (messages)
# --------------------------------------------------------------------------

@dataclass
class CommandReceipt:
    """Receipt returned by ``POST /api/rooms/{roomId}/commands``.

    ``duplicate=True`` means the envelope's idempotency id was seen before
    and the original receipt is returned.
    """

    sequence: Optional[int]
    event: Optional[RoomEvent]
    duplicate: bool = False

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "CommandReceipt":
        ev = d.get("event")
        return cls(
            sequence=_opt_int(d, "sequence"),
            event=RoomEvent.from_dict(ev) if isinstance(ev, dict) else None,
            duplicate=bool(d.get("duplicate")),
        )


@dataclass
class MessageRecord:
    """One message from the conversation window."""

    message_id: Optional[str]
    body: Optional[str]
    channel_id: Optional[str] = None
    parent_id: Optional[str] = None
    author_id: Optional[str] = None
    created_at: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "MessageRecord":
        return cls(
            message_id=_opt_str(d, "messageId"),
            body=_opt_str(d, "body"),
            channel_id=_opt_str(d, "channelId"),
            parent_id=_opt_str(d, "parentId"),
            author_id=_opt_str(d, "authorId"),
            created_at=_opt_str(d, "createdAt") or _opt_str(d, "at"),
            raw=dict(d),
        )


@dataclass
class ConversationPage:
    """One window from ``GET /api/rooms/{roomId}/conversation``."""

    messages: List[MessageRecord]
    mode: Optional[str] = None
    sequence: Optional[int] = None
    next_cursor: Optional[str] = None
    checkpoint: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ConversationPage":
        items = d.get("messages")
        return cls(
            messages=[MessageRecord.from_dict(m) for m in items] if isinstance(items, list) else [],
            mode=_opt_str(d, "mode"),
            sequence=_opt_int(d, "sequence"),
            next_cursor=_opt_str(d, "nextCursor"),
            checkpoint=_opt_str(d, "checkpoint"),
        )
