"""Tests for work-claim board operations against the fake transport."""

import unittest

from room_sdk import RoomClient
from room_sdk.errors import ConflictError, NotFoundError, ValidationError
from tests.fakes import FakeTransport, error_body


def make_client(fake: FakeTransport, room_id: str = "r") -> RoomClient:
    return RoomClient("https://room.example", "k", room_id=room_id, transport=fake)


class ListClaimsTest(unittest.TestCase):
    def test_list_parses_page_and_query(self):
        fake = FakeTransport().add(
            "GET", "/api/rooms/r/work-claims-read",
            {"roomId": "r", "claims": [{"id": "c1", "state": "unclaimed"}],
             "nextCursor": None, "evaluatedAt": "t", "consistency": "live"})
        page = make_client(fake).list_claims(state="unclaimed", limit=10)
        req = fake.last_request()
        self.assertEqual(req["query"]["state"], "unclaimed")
        self.assertEqual(req["query"]["limit"], "10")
        self.assertEqual(page.claims[0].id, "c1")

    def test_state_and_queue_cannot_combine(self):
        with self.assertRaises(ValueError):
            make_client(FakeTransport()).list_claims(state="done", queue="ready")

    def test_bad_state_filter_rejected_locally(self):
        with self.assertRaises(ValueError):
            make_client(FakeTransport()).list_claims(state="exploded")

    def test_bad_queue_filter_rejected_locally(self):
        with self.assertRaises(ValueError):
            make_client(FakeTransport()).list_claims(queue="backlog")

    def test_iter_claims_follows_cursors(self):
        fake = (FakeTransport()
                .add("GET", "/api/rooms/r/work-claims-read",
                     {"roomId": "r", "claims": [{"id": "c1"}], "nextCursor": "tok1"})
                .add("GET", "/api/rooms/r/work-claims-read",
                     {"roomId": "r", "claims": [{"id": "c2"}], "nextCursor": None}))
        ids = [c.id for c in make_client(fake).iter_claims(limit=50)]
        self.assertEqual(ids, ["c1", "c2"])
        self.assertEqual(fake.requests[1]["query"]["cursor"], "tok1")


class CreateClaimTest(unittest.TestCase):
    def test_create_sends_fields(self):
        fake = FakeTransport().add(
            "POST", "/api/rooms/r/work-claims",
            {"id": "c9", "title": "build sdk", "state": "unclaimed"})
        claim = make_client(fake).create_claim(title="build sdk",
                                              files=["a.py"], tags=["sdk"])
        body = fake.last_request()["body"]
        self.assertEqual(body["title"], "build sdk")
        self.assertEqual(body["files"], ["a.py"])
        self.assertNotIn("dependsOn", body)  # Nones are dropped
        self.assertEqual(claim.id, "c9")


class ClaimFlowTest(unittest.TestCase):
    def test_claim_body(self):
        fake = FakeTransport().add(
            "POST", "/api/rooms/r/work-claims/c1/claim",
            {"id": "c1", "state": "claimed", "owner": "me"})
        claim = make_client(fake).claim("c1", note="mine now", lease_hours=24,
                                        files=["x.py"])
        body = fake.last_request()["body"]
        self.assertEqual(body["note"], "mine now")
        self.assertEqual(body["leaseHours"], 24)
        self.assertEqual(claim.state, "claimed")

    def test_claim_conflict_maps_to_conflict_error(self):
        fake = FakeTransport().add(
            "POST", "/api/rooms/r/work-claims/c1/claim",
            error_body("work_claim_conflict", "held by agent-b"), status=409)
        with self.assertRaises(ConflictError) as ctx:
            make_client(fake).claim("c1")
        self.assertEqual(ctx.exception.code, "work_claim_conflict")

    def test_get_unknown_claim_404(self):
        fake = FakeTransport().add(
            "GET", "/api/rooms/r/work-claims/nope",
            error_body("work_claim_not_found"), status=404)
        with self.assertRaises(NotFoundError):
            make_client(fake).get_claim("nope")

    def test_update_state_done_with_delivery_mode(self):
        fake = FakeTransport().add(
            "POST", "/api/rooms/r/work-claims/c1/update",
            {"id": "c1", "state": "done"})
        claim = make_client(fake).update_claim(
            "c1", state="done", delivery_mode="result",
            reviewed_by="owner", tags=["receipt"],
            expected_claimed_at="2026-10-09T00:00:00Z",
            expected_history_length=3)
        body = fake.last_request()["body"]
        self.assertEqual(body["deliveryMode"], "result")
        self.assertEqual(body["expectedHistoryLength"], 3)
        self.assertEqual(claim.state, "done")

    def test_delivery_fields_rejected_without_done(self):
        with self.assertRaises(ValueError):
            make_client(FakeTransport()).update_claim(
                "c1", state="in_progress", delivery_mode="result")

    def test_bad_state_rejected_locally(self):
        with self.assertRaises(ValueError):
            make_client(FakeTransport()).update_claim("c1", state="vaporized")

    def test_release_is_state_unclaimed(self):
        fake = FakeTransport().add(
            "POST", "/api/rooms/r/work-claims/c1/update",
            {"id": "c1", "state": "unclaimed"})
        claim = make_client(fake).release_claim("c1")
        self.assertEqual(fake.last_request()["body"], {"state": "unclaimed"})
        self.assertEqual(claim.state, "unclaimed")

    def test_stale_update_conflict(self):
        fake = FakeTransport().add(
            "POST", "/api/rooms/r/work-claims/c1/update",
            error_body("work_claim_conflict", "round moved"), status=409)
        with self.assertRaises(ConflictError):
            make_client(fake).update_claim("c1", state="done",
                                           expected_claimed_at="t",
                                           expected_history_length=1)

    def test_server_422_maps_to_validation_error(self):
        fake = FakeTransport().add(
            "POST", "/api/rooms/r/work-claims/c1/claim",
            error_body("invalid_claim_input"), status=422)
        with self.assertRaises(ValidationError):
            make_client(fake).claim("c1", lease_hours=-5)

    def test_sweep(self):
        fake = FakeTransport().add(
            "POST", "/api/rooms/r/work-claims/sweep", {"released": 2})
        result = make_client(fake).sweep_claims()
        self.assertEqual(result["released"], 2)

    def test_append_pull_request(self):
        fake = FakeTransport().add(
            "POST", "/api/rooms/r/work-claims/c1/update",
            {"id": "c1", "state": "claimed"})
        make_client(fake).append_pull_request(
            "c1", "https://github.com/Uuriko/project-room/pull/1",
            expected_claimed_at="t", expected_history_length=1)
        body = fake.last_request()["body"]
        self.assertTrue(body["appendPullRequest"].endswith("/pull/1"))


if __name__ == "__main__":
    unittest.main()
