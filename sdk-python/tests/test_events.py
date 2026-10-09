"""Tests for event-log operations."""

import unittest

from room_sdk import RoomClient
from room_sdk.errors import ConflictError, ValidationError
from tests.fakes import FakeTransport, error_body


def make_client(fake: FakeTransport) -> RoomClient:
    return RoomClient("https://room.example", "k", room_id="r", transport=fake)


class GetEventsTest(unittest.TestCase):
    def test_poll_with_after(self):
        fake = FakeTransport().add(
            "GET", "/api/rooms/r/events",
            {"events": [{"id": "e1", "sequence": 5, "type": "message.posted",
                         "data": {}}], "next": 5, "hasMore": True})
        page = make_client(fake).get_events(after=0, limit=50)
        self.assertEqual(fake.last_request()["query"]["after"], "0")
        self.assertEqual(fake.last_request()["query"]["limit"], "50")
        self.assertEqual(page.events[0].sequence, 5)
        self.assertTrue(page.has_more)

    def test_tail_sent_alone(self):
        fake = FakeTransport().add(
            "GET", "/api/rooms/r/events",
            {"events": [], "next": 42, "hasMore": False})
        page = make_client(fake).tail_events(20)
        q = fake.last_request()["query"]
        self.assertEqual(q, {"tail": "20"})
        self.assertEqual(page.next, 42)

    def test_tail_range_rejected_locally(self):
        with self.assertRaises(ValueError):
            make_client(FakeTransport()).get_events(tail=0)
        with self.assertRaises(ValueError):
            make_client(FakeTransport()).get_events(tail=201)

    def test_tail_cannot_combine(self):
        with self.assertRaises(ValueError):
            make_client(FakeTransport()).get_events(tail=5, after=1)
        with self.assertRaises(ValueError):
            make_client(FakeTransport()).get_events(tail=5, actor="a")
        with self.assertRaises(ValueError):
            make_client(FakeTransport()).get_events(tail=5, limit=10)

    def test_cursor_ahead_maps_to_conflict(self):
        fake = FakeTransport().add(
            "GET", "/api/rooms/r/events",
            error_body("cursor_ahead", "after exceeds sequence"), status=409)
        with self.assertRaises(ConflictError) as ctx:
            make_client(fake).get_events(after=99999)
        self.assertEqual(ctx.exception.code, "cursor_ahead")

    def test_after_sequence_422(self):
        # If the server ever sees afterSequence it 422s; the client must
        # never emit that parameter (there is no such argument).
        fake = FakeTransport().add(
            "GET", "/api/rooms/r/events",
            error_body("invalid_event_cursor"), status=422)
        with self.assertRaises(ValidationError):
            make_client(fake).get_events(after=1)

    def test_iter_events_follows_next(self):
        fake = (FakeTransport()
                .add("GET", "/api/rooms/r/events",
                     {"events": [{"sequence": 1}], "next": 1, "hasMore": True})
                .add("GET", "/api/rooms/r/events",
                     {"events": [{"sequence": 2}], "next": 2, "hasMore": False}))
        seqs = [e.sequence for e in make_client(fake).iter_events(after=0)]
        self.assertEqual(seqs, [1, 2])
        self.assertEqual(fake.requests[1]["query"]["after"], "1")

    def test_iter_events_stops_on_empty_page(self):
        fake = FakeTransport().add(
            "GET", "/api/rooms/r/events",
            {"events": [], "next": 7, "hasMore": False})
        self.assertEqual(list(make_client(fake).iter_events(after=7)), [])


if __name__ == "__main__":
    unittest.main()
