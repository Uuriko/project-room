"""Room posts (messages) and conversation reads.

The write path is a single endpoint — the event command envelope::

    POST /api/rooms/{roomId}/commands   {id, type, data}

``id`` is a client-generated idempotency key (UUID): resending the same id
with the same input returns the original receipt (HTTP 200, duplicate=True);
with different input the server answers 409 ``idempotency_conflict``.

Reads::

    GET /api/rooms/{roomId}/conversation  (bounded viewer-scoped window)
"""

from __future__ import annotations

import uuid
from typing import Any, Dict, Iterator, Optional

from .models import CommandReceipt, ConversationPage, MessageRecord

# message.posted / message.edited body ceiling: 1..65536 chars.
MAX_MESSAGE_BODY = 65536


class RoomsMixin:
    """Message / conversation methods; mixed into :class:`RoomClient`."""

    # -- writes --------------------------------------------------------

    def send_command(
        self,
        command_type: str,
        data: Dict[str, Any],
        *,
        room_id: Optional[str] = None,
        command_id: Optional[str] = None,
    ) -> CommandReceipt:
        """Append one event command; generates an idempotency UUID by default.

        Pass an explicit ``command_id`` only when retrying the *same*
        command after an unknown outcome (safe duplicate); never reuse an id
        with different data.
        """
        envelope = {
            "id": command_id or str(uuid.uuid4()),
            "type": command_type,
            "data": data,
        }
        payload = self._post(  # type: ignore[attr-defined]
            f"/api/rooms/{self._room_id(room_id)}/commands",  # type: ignore[attr-defined]
            body=envelope,
        )
        return CommandReceipt.from_dict(payload)

    def post_message(
        self,
        body: str,
        *,
        room_id: Optional[str] = None,
        channel_id: Optional[str] = None,
        reply_to: Optional[str] = None,
        also_send_to_channel: bool = False,
        message_id: Optional[str] = None,
        command_id: Optional[str] = None,
    ) -> CommandReceipt:
        """Post a message to the room (``message.posted`` command).

        ``body`` is 1..65536 characters. ``reply_to`` pins the message to a
        thread root (replies land in the root's channel). ``message_id`` is
        the message's own id (auto-generated when omitted); ``command_id``
        is the envelope idempotency key (auto-generated when omitted).
        """
        if not 1 <= len(body) <= MAX_MESSAGE_BODY:
            raise ValueError(
                f"message body must be 1..{MAX_MESSAGE_BODY} characters "
                f"(got {len(body)})"
            )
        data: Dict[str, Any] = {
            "messageId": message_id or str(uuid.uuid4()),
            "body": body,
        }
        if channel_id:
            data["channelId"] = channel_id
        if reply_to:
            data["parentId"] = reply_to
        if also_send_to_channel:
            data["alsoSendToChannel"] = True
        return self.send_command("message.posted", data,
                                 room_id=room_id, command_id=command_id)

    def edit_message(
        self,
        message_id: str,
        body: str,
        *,
        room_id: Optional[str] = None,
        command_id: Optional[str] = None,
    ) -> CommandReceipt:
        """Edit one of your messages (``message.edited`` command)."""
        if not 1 <= len(body) <= MAX_MESSAGE_BODY:
            raise ValueError(
                f"message body must be 1..{MAX_MESSAGE_BODY} characters "
                f"(got {len(body)})"
            )
        return self.send_command("message.edited",
                                 {"messageId": message_id, "body": body},
                                 room_id=room_id, command_id=command_id)

    def delete_message(
        self,
        message_id: str,
        *,
        room_id: Optional[str] = None,
        command_id: Optional[str] = None,
    ) -> CommandReceipt:
        """Delete one of your messages (``message.deleted`` command)."""
        return self.send_command("message.deleted", {"messageId": message_id},
                                 room_id=room_id, command_id=command_id)

    # -- reads ----------------------------------------------------------

    def get_conversation(
        self,
        *,
        room_id: Optional[str] = None,
        limit: int = 50,
        cursor: Optional[str] = None,
        since: Optional[str] = None,
        message_id: Optional[str] = None,
        channel_id: Optional[str] = None,
    ) -> ConversationPage:
        """Read a bounded viewer-scoped conversation window.

        Choose at most one of ``cursor`` (older page), ``since``
        (conditional revalidation) or ``message_id`` (single record).
        """
        chosen = [x for x in (cursor, since, message_id) if x is not None]
        if len(chosen) > 1:
            raise ValueError("choose at most one of cursor, since, message_id")
        payload = self._get(  # type: ignore[attr-defined]
            f"/api/rooms/{self._room_id(room_id)}/conversation",  # type: ignore[attr-defined]
            query={"limit": limit, "cursor": cursor, "since": since,
                   "messageId": message_id, "channelId": channel_id},
        )
        return ConversationPage.from_dict(payload)

    def iter_conversation(
        self,
        *,
        room_id: Optional[str] = None,
        limit: int = 50,
        channel_id: Optional[str] = None,
    ) -> Iterator[MessageRecord]:
        """Yield messages from the newest window backward (follows cursor)."""
        cursor: Optional[str] = None
        while True:
            page = self.get_conversation(cursor=cursor, limit=limit,
                                         channel_id=channel_id, room_id=room_id)
            if not page.messages:
                return
            yield from page.messages
            cursor = page.next_cursor
            if not cursor:
                return
