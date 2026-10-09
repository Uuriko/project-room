"""Room event-log operations.

Endpoint map (docs/openapi.yaml)::

    GET /api/rooms/{roomId}/events   (after | tail, never both)
    GET /api/rooms/{roomId}/stream   (SSE, resumable via ?after=)

Cursor discipline, straight from the API contract:

* the cursor query parameter is ``after``, never ``afterSequence``;
* pass the previous response's ``next`` back as ``after``;
* ``tail`` is sent alone — combining it with ``after``/``limit``/filters
  is a 422 ``invalid_event_cursor``;
* ``after`` beyond the room's sequence is a 409 ``cursor_ahead``: fetch a
  fresh snapshot instead of hammering.
"""

from __future__ import annotations

from typing import Any, Dict, Iterator, Optional

from .models import EventPage, RoomEvent


class EventsMixin:
    """Event-log methods; mixed into :class:`RoomClient`."""

    def get_events(
        self,
        *,
        room_id: Optional[str] = None,
        after: Optional[int] = None,
        limit: int = 100,
        actor: Optional[str] = None,
        since: Optional[str] = None,
        until: Optional[str] = None,
        tail: Optional[int] = None,
    ) -> EventPage:
        """Read the ordered event log.

        Either poll with ``after`` (a previously returned ``next`` value)
        or read the newest ``tail`` events alone. Do not send
        ``afterSequence`` — the server does not have that parameter.
        """
        if tail is not None:
            if after is not None or limit != 100 or actor or since or until:
                raise ValueError("tail cannot be combined with after/limit/filters")
            if not 1 <= tail <= 200:
                raise ValueError("tail must be between 1 and 200")
            query: Dict[str, Any] = {"tail": tail}
        else:
            if after is not None and after < 0:
                raise ValueError("after must be >= 0")
            query = {"after": after if after is not None else 0,
                     "limit": limit, "actor": actor,
                     "since": since, "until": until}
        payload = self._get(  # type: ignore[attr-defined]
            f"/api/rooms/{self._room_id(room_id)}/events",  # type: ignore[attr-defined]
            query=query,
        )
        return EventPage.from_dict(payload)

    def tail_events(self, n: int = 20, *, room_id: Optional[str] = None) -> EventPage:
        """Newest ``n`` events in ascending order (plus ``next`` to continue)."""
        return self.get_events(tail=n, room_id=room_id)

    def iter_events(
        self,
        *,
        room_id: Optional[str] = None,
        after: int = 0,
        limit: int = 100,
        actor: Optional[str] = None,
    ) -> Iterator[RoomEvent]:
        """Yield events from ``after`` onward, following ``next`` cursors."""
        cursor: Optional[int] = after
        while True:
            page = self.get_events(after=cursor, limit=limit,
                                   actor=actor, room_id=room_id)
            if not page.events:
                return
            yield from page.events
            if not page.has_more:
                return
            cursor = page.next if page.next is not None else cursor
