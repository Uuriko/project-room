"""The high-level client.

:class:`RoomClient` is the only thing most callers touch. Claims, events
and room-post methods come from the mixin modules; this module owns auth,
URL building, JSON decode, and the HTTP-status -> error-taxonomy mapping.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Mapping, Optional

from .claims import ClaimsMixin
from .errors import TransportError, error_from_response
from .events import EventsMixin
from .http import Response, Transport, UrllibTransport, build_url, json_body, parse_retry_after
from .rooms import RoomsMixin


class RoomClient(ClaimsMixin, EventsMixin, RoomsMixin):
    """A client for one Project Room server (optionally one default room).

    Args:
        base_url: server origin, e.g. ``https://room.trydemigod.com``.
        api_key: room or agent credential, sent as ``Authorization: Bearer``.
        room_id: default room id used when a call does not pass ``room_id``.
        transport: inject a fake for tests; defaults to :class:`UrllibTransport`.
        timeout: per-request timeout in seconds.
        user_agent: sent on every request.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        room_id: Optional[str] = None,
        transport: Optional[Transport] = None,
        timeout: float = 30.0,
        user_agent: str = "room-sdk-python/0.1.0",
    ) -> None:
        if not base_url:
            raise ValueError("base_url is required")
        if not api_key:
            raise ValueError("api_key is required")
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key
        self.room_id = room_id
        self.transport: Transport = transport or UrllibTransport()
        self.timeout = timeout
        self.user_agent = user_agent

    # -- internals -------------------------------------------------------

    def _room_id(self, room_id: Optional[str]) -> str:
        rid = room_id or self.room_id
        if not rid:
            raise ValueError("room_id is required (pass it or set a client default)")
        return rid

    def _headers(self, extra: Optional[Mapping[str, str]] = None) -> Dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "User-Agent": self.user_agent,
            "Accept": "application/json",
        }
        if extra:
            headers.update(extra)
        return headers

    def _request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, Any]] = None,
        body: Optional[Any] = None,
    ) -> Any:
        url = build_url(self.base_url, path, query)
        headers = self._headers()
        payload: Optional[bytes] = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json_body(body)
        status, resp_headers, raw = self.transport.request(
            method, url, headers=headers, body=payload, timeout=self.timeout
        )
        parsed: Any = None
        if raw:
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                parsed = None
        if status >= 400:
            raise error_from_response(
                status,
                parsed if isinstance(parsed, dict) else None,
                retry_after=parse_retry_after(resp_headers),
            )
        if 200 <= status < 300 and status != 204:
            if parsed is None and raw:
                raise TransportError(
                    f"expected JSON response from {method} {path}, got undecodable body"
                )
            return parsed
        return parsed

    def _get(self, path: str, *, query: Optional[Mapping[str, Any]] = None) -> Any:
        return self._request("GET", path, query=query)

    def _post(self, path: str, body: Optional[Any] = None) -> Any:
        return self._request("POST", path, body=body)

    # -- repr --------------------------------------------------------------

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"RoomClient(base_url={self.base_url!r}, room_id={self.room_id!r})"
