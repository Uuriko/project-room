"""Tests for room posts (commands) and conversation reads."""

import unittest
import uuid

from room_sdk import RoomClient
from room_sdk.errors import ConflictError
from room_sdk.rooms import MAX_MESSAGE_BODY
from tests.fakes import FakeTransport, error_body


def make_client(fake: FakeTransport) -> RoomClient:
    return RoomClient("https://room.example", "k", room_id="r", transport=fake)


class PostMessageTest(unittest.TestCase):
    def test_post_message_envelope(self):
        fake = FakeTransport().add(
            "POST", "/api/rooms/r/commands",
            {"sequence": 100, "event": {"type": "message.posted", "data": {}},
             "duplicate": False})
        receipt = make_client(fake).post_message("hello", channel_id="general")
        body = fake.last_request()["body"]
        self.assertEqual(body["type"], "message.posted")
        self.assertEqual(body["data"]["body"], "hello")
        self.assertEqual(body["data"]["channelId"], "general")
        # both ids are valid UUIDs, generated client-side
        uuid.UUID(body["id"])
        uuid.UUID(body["data"]["messageId"])
        self.assertEqual(receipt.sequence, 100)
        self.assertFalse(receipt.duplicate)

    def test_reply_pins_thread_root(self):
        fake = FakeTransport().add(
            "POST", "/api/rooms/r/commands", {"sequence": 1})
        make_client(fake).post_message("reply", reply_to="root1",
                                       also_send_to_channel=True)
        data = fake.last_request()["body"]["data"]
        self.assertEqual(data["replyToId"], "root1")
        self.assertTrue(data["alsoSendToChannel"])

    def test_command_id_without_message_id_raises_fail_fast(self):
        # M5: a reused command_id with a regenerated messageId is a 409
        # idempotency_conflict, not a safe duplicate. The SDK must refuse
        # to emit that wire sequence instead of letting the server fail it.
        client = make_client(FakeTransport())
        with self.assertRaises(ValueError):
            client.post_message("retry", command_id="cmd-retry")

    def test_command_id_with_message_id_passes_through(self):
        # The documented retry recipe: same command_id AND same message_id.
        fake = FakeTransport().add(
            "POST", "/api/rooms/r/commands",
            {"sequence": 5, "duplicate": True})
        receipt = make_client(fake).post_message(
            "retry", command_id="cmd-retry", message_id="msg-1")
        body = fake.last_request()["body"]
        self.assertEqual(body["id"], "cmd-retry")
        self.assertEqual(body["data"]["messageId"], "msg-1")
        self.assertTrue(receipt.duplicate)

    def test_empty_and_oversized_bodies_rejected_locally(self):
        client = make_client(FakeTransport())
        with self.assertRaises(ValueError):
            client.post_message("")
        with self.assertRaises(ValueError):
            client.post_message("x" * (MAX_MESSAGE_BODY + 1))

    def test_idempotent_duplicate_returns_receipt(self):
        fake = FakeTransport().add(
            "POST", "/api/rooms/r/commands",
            {"sequence": 100, "duplicate": True})
        receipt = make_client(fake).send_command(
            "message.posted", {"messageId": "m1", "body": "hi"},
            command_id="cmd-1")
        body = fake.last_request()["body"]
        self.assertEqual(body["id"], "cmd-1")
        self.assertTrue(receipt.duplicate)

    def test_idempotency_conflict(self):
        fake = FakeTransport().add(
            "POST", "/api/rooms/r/commands",
            error_body("idempotency_conflict", "same id, different input"),
            status=409)
        with self.assertRaises(ConflictError) as ctx:
            make_client(fake).send_command("message.posted", {"body": "changed"},
                                           command_id="cmd-1")
        self.assertEqual(ctx.exception.code, "idempotency_conflict")

    def test_edit_and_delete(self):
        fake = (FakeTransport()
                .add("POST", "/api/rooms/r/commands", {"sequence": 2})
                .add("POST", "/api/rooms/r/commands", {"sequence": 3}))
        client = make_client(fake)
        client.edit_message("m1", "new body")
        self.assertEqual(fake.requests[0]["body"]["type"], "message.edited")
        client.delete_message("m1")
        self.assertEqual(fake.requests[1]["body"]["type"], "message.deleted")


class ConversationTest(unittest.TestCase):
    def test_get_conversation(self):
        fake = FakeTransport().add(
            "GET", "/api/rooms/r/conversation",
            {"messages": [{"messageId": "m1", "body": "hi", "channelId": "general"}],
             "mode": "replace", "sequence": 5, "nextCursor": None})
        page = make_client(fake).get_conversation(limit=50)
        self.assertEqual(page.messages[0].body, "hi")
        self.assertEqual(page.mode, "replace")
        self.assertEqual(fake.last_request()["query"]["limit"], "50")

    def test_single_selection_rule(self):
        client = make_client(FakeTransport())
        with self.assertRaises(ValueError):
            client.get_conversation(cursor="a", since="b")

    def test_iter_conversation_follows_cursor(self):
        fake = (FakeTransport()
                .add("GET", "/api/rooms/r/conversation",
                     {"messages": [{"messageId": "m1", "body": "one"}],
                      "nextCursor": "tok"})
                .add("GET", "/api/rooms/r/conversation",
                     {"messages": [{"messageId": "m2", "body": "two"}],
                      "nextCursor": None}))
        bodies = [m.body for m in make_client(fake).iter_conversation()]
        self.assertEqual(bodies, ["one", "two"])
        self.assertEqual(fake.requests[1]["query"]["cursor"], "tok")


if __name__ == "__main__":
    unittest.main()
