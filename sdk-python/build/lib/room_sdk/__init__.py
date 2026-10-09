"""room_sdk — a clean Python client for the Project Room public API.

Covers three surfaces:

* **claims** — the work-claim board (read pages, create, claim, update,
  release, PR links, sweeps);
* **events** — the ordered room event log (poll with ``after`` cursors,
  or read the newest ``tail``);
* **room posts** — messages via the single ``/commands`` write path with
  UUID idempotency keys, plus bounded conversation reads.

Stdlib only. Errors follow docs/ERROR-TAXONOMY.md as a typed hierarchy.

Quick start::

    from room_sdk import RoomClient

    client = RoomClient("https://room.trydemigod.com", api_key="...", room_id="muse-room")
    client.post_message("hello room")
    for claim in client.iter_claims(state="unclaimed"):
        print(claim.id, claim.title)
"""

from .client import RoomClient
from .errors import (
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
from .http import UrllibTransport, Transport
from .models import (
    ClaimConfig,
    ClaimPage,
    CommandReceipt,
    ConversationPage,
    EventPage,
    MessageRecord,
    RoomEvent,
    WorkClaim,
)

__version__ = "0.1.0"

__all__ = [
    "RoomClient",
    "RoomError",
    "AuthenticationError",
    "ForbiddenError",
    "NotFoundError",
    "ConflictError",
    "ValidationError",
    "RateLimitedError",
    "UnavailableError",
    "ServerError",
    "TransportError",
    "error_from_response",
    "UrllibTransport",
    "Transport",
    "WorkClaim",
    "ClaimPage",
    "ClaimConfig",
    "RoomEvent",
    "EventPage",
    "CommandReceipt",
    "MessageRecord",
    "ConversationPage",
]
