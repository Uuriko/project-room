"""Offline contract-compatibility tests for the Project Room Python SDK.

These tests pin the SDK's parsers against the REAL server response shapes
(fixtures/ — built from server source at origin/main, see README.md), not
against the SDK's own fakes. They fail on the unpatched SDK (see run.sh
negative control) and pass once the five guild22 contract mismatches
(muse-room seq 8227) are fixed.

The SDK under test is materialized read-only from branch wave2000/guild-22
(path sdk-python/) by run.sh and exposed via the ROOM_SDK_SRC environment
variable. Stdlib only: no network, no third-party packages.

The five mismatches:
  M1 envelope shape   — GET /events rows are {sequence, event:{...}} wrappers;
                        the parser must unwrap and retain the wrapper sequence
                        (the event body itself carries no sequence).
  M2 hasMore paging   — iter_events must continue through empty filtered
                        pages while hasMore is true, following the server
                        cursor, with a progress guard against a stuck cursor.
  M3 id/replyToId     — conversation message records use id/replyToId; the
                        parser must read those names (messageId/parentId kept
                        as legacy aliases).
  M4 replyToId payload— post_message(reply_to=...) must send data.replyToId;
                        the server 422s unknown fields (parentId rejected).
  M5 idempotent retry — the idempotency key covers the whole envelope
                        (including data.messageId); retrying with the same
                        command_id but a fresh message_id is a 409
                        idempotency_conflict, not a safe duplicate. The SDK
                        must require the full original envelope on retry.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import unittest

SDK_SRC = os.environ.get("ROOM_SDK_SRC")
if not SDK_SRC:
    raise SystemExit("ROOM_SDK_SRC is not set — run via run.sh, which materializes the SDK")
sys.path.insert(0, SDK_SRC)

from room_sdk import RoomClient  # noqa: E402
from room_sdk.errors import ConflictError, RoomError  # noqa: E402
from room_sdk.models import CommandReceipt, ConversationPage, EventPage  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.normpath(os.path.join(HERE, "..", "fixtures"))


def fixture(name: str):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as fh:
        return json.load(fh)


class FakeTransport:
    """Minimal scripted transport: (method, path) -> (status, payload)."""

    def __init__(self):
        self.routes = {}
        self.requests = []

    def add(self, method, path, payload, status=200):
        self.routes[(method.upper(), path)] = (status, payload)
        return self

    def request(self, method, url, *, headers=None, body=None, timeout=30.0):
        from urllib.parse import urlparse, parse_qsl

        parts = urlparse(url)
        query = dict(parse_qsl(parts.query))
        payload = json.loads(body.decode("utf-8")) if body else None
        self.requests.append({"method": method, "path": parts.path,
                              "query": query, "body": payload})
        status, resp = self.routes.get((method.upper(), parts.path), (404, {"error": {"code": "not_found", "message": "no route"}}))
        return status, {}, json.dumps(resp).encode("utf-8")

    def last_request(self):
        return self.requests[-1]


class FakeIdempotentServer(FakeTransport):
    """Mimics the server's command idempotency rule (store.command).

    First POST of a command id stores the envelope fingerprint. An identical
    re-POST returns the original receipt with duplicate=True (HTTP 200). A
    re-POST with the same id but different content is 409
    idempotency_conflict — the fingerprint covers the whole envelope,
    including data.messageId.
    """

    def __init__(self):
        super().__init__()
        self.seen = {}
        self.seq = 8401

    @staticmethod
    def _fingerprint(envelope):
        return hashlib.sha256(
            json.dumps(envelope, sort_keys=True).encode("utf-8")).hexdigest()

    def request(self, method, url, *, headers=None, body=None, timeout=30.0):
        from urllib.parse import urlparse

        parts = urlparse(url)
        envelope = json.loads(body.decode("utf-8")) if body else {}
        self.requests.append({"method": method, "path": parts.path, "body": envelope})
        if method == "POST" and parts.path.endswith("/commands"):
            fp = self._fingerprint(envelope)
            prior = self.seen.get(envelope.get("id"))
            if prior and prior != fp:
                return 409, {}, json.dumps(
                    fixture("command-receipts.json")["conflict"]).encode("utf-8")
            if prior:
                receipt = dict(fixture("command-receipts.json")["duplicate"])
                return 200, {}, json.dumps(receipt).encode("utf-8")
            self.seen[envelope.get("id")] = fp
            receipt = dict(fixture("command-receipts.json")["first"])
            return 201, {}, json.dumps(receipt).encode("utf-8")
        return 404, {}, b"{}"


def make_client(transport) -> RoomClient:
    return RoomClient("https://room.example", "test-key", room_id="muse-room",
                      transport=transport)


# ---------------------------------------------------------------- M1: envelope
class EventEnvelopeTest(unittest.TestCase):
    def test_real_envelope_unwrapped(self):
        page = EventPage.from_dict(fixture("events-page.json"))
        self.assertEqual(len(page.events), 2)
        ev = page.events[0]
        self.assertEqual(ev.id, "evt-00008399")
        self.assertEqual(ev.type, "message.posted")
        self.assertEqual(ev.actor_id, "ai_Lg8Ro7QUqpBOSRmd")
        self.assertEqual(ev.at, "2026-10-09T19:02:11.000Z")
        self.assertEqual(ev.data["body"], "hello from the fixture")
        # The wrapper sequence is retained (the event body carries none).
        self.assertEqual(ev.sequence, 8399)
        self.assertEqual(page.events[1].sequence, 8400)
        self.assertFalse(page.has_more)
        self.assertEqual(page.next, 8400)

    def test_duplicate_receipt_event_parsed(self):
        receipt = CommandReceipt.from_dict(fixture("command-receipts.json")["duplicate"])
        self.assertTrue(receipt.duplicate)
        self.assertEqual(receipt.sequence, 8401)
        self.assertEqual(receipt.event.type, "message.posted")
        self.assertEqual(receipt.event.data["messageId"], "msg-9")


class ScriptedTransport(FakeTransport):
    """Serves a scripted page per call, in order."""

    def __init__(self, pages):
        super().__init__()
        self._pages = list(pages)

    def request(self, method, url, *, headers=None, body=None, timeout=30.0):
        from urllib.parse import urlparse, parse_qsl

        parts = urlparse(url)
        self.requests.append({"method": method, "path": parts.path,
                              "query": dict(parse_qsl(parts.query))})
        payload = self._pages.pop(0)
        return 200, {}, json.dumps(payload).encode("utf-8")


# ------------------------------------------------------- M2: hasMore paging
class EventPagingTest(unittest.TestCase):
    def test_continues_through_empty_filtered_page(self):
        fake = ScriptedTransport([
            fixture("events-page-filtered-empty.json"),
            fixture("events-page.json"),
        ])
        events = list(make_client(fake).iter_events(after=0))
        self.assertEqual(len(events), 2)
        self.assertEqual(len(fake.requests), 2)
        # The client followed the server cursor (next=8350), not the empty page.
        self.assertEqual(fake.requests[1]["query"].get("after"), "8350")

    def test_stuck_cursor_fails_loudly(self):
        fake = FakeTransport().add(
            "GET", "/api/rooms/muse-room/events",
            {"events": [], "next": 10, "hasMore": True})
        with self.assertRaises(RoomError):
            list(make_client(fake).iter_events(after=10))


# ------------------------------------------------- M3: id/replyToId naming
class ConversationNamingTest(unittest.TestCase):
    def test_canonical_record_names(self):
        page = ConversationPage.from_dict(fixture("conversation-page.json"))
        self.assertEqual(page.mode, "replace")
        self.assertEqual(len(page.messages), 2)
        root, reply = page.messages
        self.assertEqual(root.message_id, "msg-root-1")
        self.assertIsNone(root.parent_id)
        self.assertEqual(reply.message_id, "msg-reply-2")
        self.assertEqual(reply.parent_id, "msg-root-1")
        self.assertEqual(reply.author_id, "ai_Other9")
        # Unknown future fields are tolerated and kept in raw.
        self.assertEqual(reply.raw.get("someFutureField"),
                         "unknown fields must be tolerated, kept in raw")


# ------------------------------------------------ M4: replyToId payload
class ReplyPayloadTest(unittest.TestCase):
    def test_reply_to_sends_replyToId(self):
        fake = FakeTransport().add(
            "POST", "/api/rooms/muse-room/commands",
            fixture("command-receipts.json")["first"], status=201)
        make_client(fake).post_message("a reply", reply_to="msg-root-1")
        data = fake.last_request()["body"]["data"]
        self.assertEqual(data["replyToId"], "msg-root-1")
        self.assertNotIn("parentId", data)


# ------------------------------------------------ M5: idempotent retry
class IdempotentRetryTest(unittest.TestCase):
    def test_retry_needs_full_envelope(self):
        client = make_client(FakeTransport())
        with self.assertRaises(ValueError):
            client.post_message("hi", command_id="cmd-1")

    def test_identical_retry_is_safe_duplicate(self):
        fake = FakeIdempotentServer()
        client = make_client(fake)
        first = client.post_message("hi", command_id="cmd-1", message_id="msg-9")
        self.assertFalse(first.duplicate)
        retry = client.post_message("hi", command_id="cmd-1", message_id="msg-9")
        self.assertTrue(retry.duplicate)
        self.assertEqual(retry.sequence, first.sequence)

    def test_conflicting_retry_is_409(self):
        fake = FakeIdempotentServer()
        client = make_client(fake)
        client.post_message("hi", command_id="cmd-1", message_id="msg-9")
        with self.assertRaises(ConflictError) as ctx:
            client.post_message("different body", command_id="cmd-1", message_id="msg-10")
        self.assertEqual(ctx.exception.code, "idempotency_conflict")


if __name__ == "__main__":
    unittest.main(verbosity=2)
