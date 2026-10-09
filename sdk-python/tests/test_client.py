"""Tests for RoomClient plumbing: auth, URL building, transport errors."""

import unittest

from room_sdk import RoomClient
from room_sdk.errors import AuthenticationError, TransportError
from room_sdk.http import UrllibTransport, build_url, parse_retry_after
from tests.fakes import FakeTransport, error_body


class ClientSetupTest(unittest.TestCase):
    def test_missing_base_url_or_key(self):
        with self.assertRaises(ValueError):
            RoomClient("", "k")
        with self.assertRaises(ValueError):
            RoomClient("https://x", "")

    def test_room_id_required_when_no_default(self):
        fake = FakeTransport()
        client = RoomClient("https://x", "k", transport=fake)
        with self.assertRaises(ValueError):
            client.get_events()

    def test_bearer_header_sent(self):
        fake = FakeTransport().add(
            "GET", "/api/rooms/r/work-claims-read", {"roomId": "r", "claims": []})
        RoomClient("https://x", "secret", room_id="r",
                   transport=fake).list_claims()
        headers = fake.last_request()["headers"]
        self.assertEqual(headers["Authorization"], "Bearer secret")
        self.assertIn("room-sdk-python", headers["User-Agent"])

    def test_401_maps_to_authentication_error(self):
        fake = FakeTransport().add(
            "GET", "/api/rooms/r/events",
            error_body("credential_expired"), status=401)
        with self.assertRaises(AuthenticationError):
            RoomClient("https://x", "bad", room_id="r",
                       transport=fake).get_events()

    def test_non_json_error_body_still_maps(self):
        fake = (FakeTransport()
                .add("GET", "/api/rooms/r/events", {}, status=503, raw=b"<html>down</html>"))
        from room_sdk.errors import UnavailableError
        with self.assertRaises(UnavailableError):
            RoomClient("https://x", "k", room_id="r",
                       transport=fake).get_events()

    def test_retry_after_header_surfaced(self):
        fake = (FakeTransport()
                .add("GET", "/api/rooms/r/events", error_body("slow_down"),
                     status=429, headers={"Retry-After": "5"}))
        from room_sdk.errors import RateLimitedError
        try:
            RoomClient("https://x", "k", room_id="r", transport=fake).get_events()
            self.fail("expected RateLimitedError")
        except RateLimitedError as e:
            self.assertEqual(e.retry_after, 5.0)

    def test_undecodable_success_body_is_transport_error(self):
        fake = FakeTransport().add(
            "GET", "/api/rooms/r/events", {}, status=200, raw=b"not json {{{")
        with self.assertRaises(TransportError):
            RoomClient("https://x", "k", room_id="r",
                       transport=fake).get_events()

    def test_transport_failure_is_transport_error(self):
        class Boom(FakeTransport):
            def request(self, *a, **k):
                from room_sdk.errors import TransportError as TE
                raise TE("connection refused")
        with self.assertRaises(TransportError):
            RoomClient("https://x", "k", room_id="r",
                       transport=Boom()).get_events()

    def test_per_call_room_id_overrides_default(self):
        fake = FakeTransport().add(
            "GET", "/api/rooms/other/events", {"events": [], "next": 0})
        RoomClient("https://x", "k", room_id="r",
                   transport=fake).get_events(room_id="other")
        self.assertEqual(fake.last_request()["path"], "/api/rooms/other/events")


class HttpHelpersTest(unittest.TestCase):
    def test_build_url(self):
        url = build_url("https://x/", "/api/e",
                        {"after": 0, "limit": 100, "actor": None})
        self.assertEqual(url, "https://x/api/e?after=0&limit=100")

    def test_parse_retry_after(self):
        self.assertEqual(parse_retry_after({"Retry-After": "30"}), 30.0)
        self.assertIsNone(parse_retry_after({}))
        self.assertIsNone(parse_retry_after({"Retry-After": "someday"}))

    def test_urllib_transport_is_default(self):
        client = RoomClient("https://x", "k")
        self.assertIsInstance(client.transport, UrllibTransport)


if __name__ == "__main__":
    unittest.main()
