"""HTTP transport layer.

``Transport`` is the small interface the client speaks to, so tests can
inject fakes without any network. The stdlib-only ``UrllibTransport`` is
the production implementation.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Mapping, Optional, Tuple

from .errors import TransportError

Response = Tuple[int, Dict[str, str], bytes]
"""``(http_status, headers, body_bytes)`` returned by a transport call."""


class Transport:
    """Interface for issuing one HTTP request."""

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Optional[Mapping[str, str]] = None,
        body: Optional[bytes] = None,
        timeout: float = 30.0,
    ) -> Response:
        raise NotImplementedError


class UrllibTransport(Transport):
    """Stdlib transport using :mod:`urllib`. No third-party dependencies."""

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Optional[Mapping[str, str]] = None,
        body: Optional[bytes] = None,
        timeout: float = 30.0,
    ) -> Response:
        req = urllib.request.Request(
            url, data=body, headers=dict(headers or {}), method=method.upper()
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.status, dict(res.headers.items()), res.read()
        except urllib.error.HTTPError as e:
            # HTTPError still carries the status and body of the error page.
            try:
                payload = e.read()
            except Exception:  # pragma: no cover - defensive
                payload = b""
            return e.code, dict(e.headers.items()), payload
        except Exception as e:  # DNS, refused, timeout, TLS...
            raise TransportError(f"transport failed: {e}") from e


def build_url(base: str, path: str, query: Optional[Mapping[str, Any]] = None) -> str:
    """Join base + path and encode query params, dropping ``None`` values."""
    base = base.rstrip("/")
    if not path.startswith("/"):
        path = "/" + path
    url = base + path
    if query:
        params = {k: v for k, v in query.items() if v is not None}
        if params:
            url += "?" + urllib.parse.urlencode(params, doseq=True)
    return url


def json_body(payload: Any) -> bytes:
    return json.dumps(payload).encode("utf-8")


def parse_retry_after(headers: Mapping[str, str]) -> Optional[float]:
    """Parse the Retry-After header (delta-seconds; dates are out of scope)."""
    value = headers.get("Retry-After") or headers.get("retry-after")
    if value is None:
        return None
    try:
        return max(0.0, float(str(value).strip()))
    except ValueError:
        return None
