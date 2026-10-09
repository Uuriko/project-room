"""Tests for the error taxonomy (docs/ERROR-TAXONOMY.md mapping)."""

import unittest

from room_sdk.errors import (
    AuthenticationError,
    ConflictError,
    ForbiddenError,
    NotFoundError,
    RateLimitedError,
    RoomError,
    ServerError,
    TransportError,
    UnavailableError,
    ValidationError,
    error_from_response,
)
from tests.fakes import error_body


class ErrorMappingTest(unittest.TestCase):
    def test_status_to_class(self):
        cases = {
            401: AuthenticationError,
            403: ForbiddenError,
            404: NotFoundError,
            409: ConflictError,
            422: ValidationError,
            429: RateLimitedError,
            503: UnavailableError,
            500: ServerError,
            502: ServerError,
        }
        for status, cls in cases.items():
            err = error_from_response(status, error_body("some_code"))
            self.assertIsInstance(err, cls, f"status {status}")
            self.assertIsInstance(err, RoomError)
            self.assertEqual(err.http_status, status)
            self.assertEqual(err.code, "some_code")

    def test_unknown_4xx_falls_back_to_room_error(self):
        err = error_from_response(418, error_body("teapot"))
        self.assertIsInstance(err, RoomError)
        self.assertNotIsInstance(err, ServerError)

    def test_body_fields_are_carried(self):
        err = error_from_response(
            409, error_body("work_claim_conflict", "held by agent-b", hint="wait it out"),
            retry_after=30,
        )
        self.assertIsInstance(err, ConflictError)
        self.assertEqual(str(err.args[0]), "held by agent-b")
        self.assertEqual(err.hint, "wait it out")
        self.assertEqual(err.retry_after, 30)

    def test_bare_response_still_builds(self):
        err = error_from_response(404, None)
        self.assertIsInstance(err, NotFoundError)
        self.assertIsNone(err.code)

    def test_next_steps_list_carried(self):
        err = error_from_response(409, {"error": {"code": "session_claimed"},
                                       "next": [{"tool": "room_list_work"}]})
        self.assertEqual(err.next, [{"tool": "room_list_work"}])

    def test_retryable_only_for_rate_limit_and_unavailable(self):
        self.assertTrue(error_from_response(429, None).is_retryable)
        self.assertTrue(error_from_response(503, None).is_retryable)
        self.assertFalse(error_from_response(409, None).is_retryable)
        self.assertFalse(error_from_response(422, None).is_retryable)
        self.assertFalse(TransportError("x").is_retryable)


if __name__ == "__main__":
    unittest.main()
