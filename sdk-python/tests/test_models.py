"""Tests for model parsing: tolerant of unknown fields, correct derivations."""

import unittest

from room_sdk.models import (
    ClaimPage,
    CommandReceipt,
    ConversationPage,
    EventPage,
    MessageRecord,
    RoomEvent,
    WorkClaim,
)


class WorkClaimTest(unittest.TestCase):
    def test_parses_and_tolerates_unknown_fields(self):
        claim = WorkClaim.from_dict({
            "id": "c1", "roomId": "r", "title": "do things", "state": "claimed",
            "owner": "agent-a", "claimedAt": "2026-10-09T00:00:00Z",
            "leaseExpiresAt": "2026-10-10T00:00:00Z",
            "files": ["a/b.py", 42], "dependsOn": ["c0"], "tags": ["t"],
            "history": [{"x": 1}, {"x": 2}], "historyOmitted": 5,
            "someFutureField": {"nested": True},
        })
        self.assertEqual(claim.id, "c1")
        self.assertEqual(claim.state, "claimed")
        self.assertEqual(claim.files, ["a/b.py"])
        self.assertEqual(claim.history_length, 7)
        self.assertIn("someFutureField", claim.raw)

    def test_missing_history_gives_none_length(self):
        claim = WorkClaim.from_dict({"id": "c2"})
        self.assertIsNone(claim.history_length)
        self.assertEqual(claim.files, [])

    def test_claim_page(self):
        page = ClaimPage.from_dict({
            "roomId": "r", "claims": [{"id": "c1"}], "nextCursor": "abc",
            "evaluatedAt": "2026-10-09T00:00:00Z", "consistency": "live",
        })
        self.assertEqual(len(page.claims), 1)
        self.assertEqual(page.next_cursor, "abc")
        self.assertEqual(page.consistency, "live")

    def test_claim_page_without_claims_list(self):
        page = ClaimPage.from_dict({"roomId": "r"})
        self.assertEqual(page.claims, [])
        self.assertIsNone(page.next_cursor)


class RoomEventTest(unittest.TestCase):
    def test_event_page(self):
        page = EventPage.from_dict({
            "events": [
                {"id": "e1", "sequence": 10, "type": "message.posted",
                 "actorId": "a", "at": "2026-10-09T00:00:00Z", "data": {"body": "hi"}},
            ],
            "next": 10, "hasMore": False,
        })
        self.assertEqual(len(page.events), 1)
        ev = page.events[0]
        self.assertEqual(ev.sequence, 10)
        self.assertEqual(ev.data["body"], "hi")
        self.assertEqual(page.next, 10)
        self.assertFalse(page.has_more)


class CommandReceiptTest(unittest.TestCase):
    def test_receipt_with_duplicate(self):
        r = CommandReceipt.from_dict({
            "sequence": 42, "duplicate": True,
            "event": {"type": "message.posted", "data": {}},
        })
        self.assertTrue(r.duplicate)
        self.assertEqual(r.sequence, 42)
        self.assertIsNotNone(r.event)
        self.assertEqual(r.event.type, "message.posted")

    def test_receipt_without_event(self):
        r = CommandReceipt.from_dict({"sequence": 1})
        self.assertFalse(r.duplicate)
        self.assertIsNone(r.event)


class ConversationTest(unittest.TestCase):
    def test_message_record(self):
        m = MessageRecord.from_dict({
            "messageId": "m1", "body": "hello", "channelId": "general",
            "parentId": "root", "authorId": "agent-a",
            "createdAt": "2026-10-09T00:00:00Z",
        })
        self.assertEqual(m.message_id, "m1")
        self.assertEqual(m.channel_id, "general")
        self.assertEqual(m.parent_id, "root")

    def test_conversation_page(self):
        p = ConversationPage.from_dict({
            "messages": [{"messageId": "m1", "body": "hi"}],
            "mode": "replace", "sequence": 99, "nextCursor": "tok",
        })
        self.assertEqual(p.mode, "replace")
        self.assertEqual(p.next_cursor, "tok")
        self.assertEqual(len(p.messages), 1)


if __name__ == "__main__":
    unittest.main()
