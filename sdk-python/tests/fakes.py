"""Fake transport for tests: scripted (method, path) -> response.

Unknown method/path pairs raise AssertionError, so a test that hits an
endpoint the fake does not model fails loudly instead of passing against
a silent default.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Mapping, Optional, Tuple
from urllib.parse import urlparse, parse_qsl

from room_sdk.http import Response, Transport


class FakeTransport(Transport):
    """Scripted HTTP double.

    Usage::

        fake = FakeTransport()
        fake.add("GET", "/api/rooms/r/work-claims-read", {"claims": [...], ...})
        client = RoomClient("https://x", "k", room_id="r", transport=fake)
        ...
        fake.assert_requested("GET", "/api/rooms/r/work-claims-read")
    """

    def __init__(self) -> None:
        self.routes: Dict[Tuple[str, str], List[Tuple[int, Dict[str, str], bytes]]] = {}
        self.requests: List[Dict[str, Any]] = []

    def add(
        self,
        method: str,
        path: str,
        payload: Any,
        *,
        status: int = 200,
        headers: Optional[Dict[str, str]] = None,
        raw: Optional[bytes] = None,
    ) -> "FakeTransport":
        key = (method.upper(), path)
        body = raw if raw is not None else json.dumps(payload).encode()
        self.routes.setdefault(key, []).append((status, dict(headers or {}), body))
        return self

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Optional[Mapping[str, str]] = None,
        body: Optional[bytes] = None,
        timeout: float = 30.0,
    ) -> Response:
        parts = urlparse(url)
        query = dict(parse_qsl(parts.query))
        self.requests.append(
            {"method": method.upper(), "path": parts.path, "query": query,
             "headers": dict(headers or {}),
             "body": json.loads(body.decode()) if body else None}
        )
        key = (method.upper(), parts.path)
        queue = self.routes.get(key)
        if not queue:
            raise AssertionError(
                f"FakeTransport: no route for {method.upper()} {parts.path} "
                f"(query={query}); register it with fake.add(...) first"
            )
        return queue.pop(0)

    # -- assertions --------------------------------------------------------

    def last_request(self) -> Dict[str, Any]:
        assert self.requests, "no requests were made"
        return self.requests[-1]

    def assert_requested(self, method: str, path: str) -> Dict[str, Any]:
        for req in self.requests:
            if req["method"] == method.upper() and req["path"] == path:
                return req
        raise AssertionError(f"no {method.upper()} {path} among {[ (r['method'], r['path']) for r in self.requests ]}")


def error_body(code: str, message: str = "nope", hint: Optional[str] = None) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"error": {"code": code, "message": message}}
    if hint:
        payload["hint"] = hint
    return payload
