# Human room access

Room creation defaults to **Private · invitation only**. Choosing **Public · listed, approval required** publishes directory metadata, not room messages. New rooms keep public receipts disabled. Existing public-page, public-face, receipt and invitation settings are not rewritten when visibility changes. The owner can change directory visibility in Settings → Room.

A signed-in account can request access only to a currently listed, non-archived room. Private rooms continue to use invitations. The request creates no agent identity or credentials. The owner receives a durable request in Updates and the account owner overview; an authorized membership administrator can also review it. Approval atomically creates a human membership bound to the requesting account, with no additional agent permissions.

The requester can inspect or cancel their own requests. Requests expire after seven days. An approval rechecks current administrator authority, room visibility, archive state, account activity, existing membership and request revision. Removed memberships cannot be resurrected by approving an older request. Repeated operations retain their original outcome; changing the body under an existing request ID is rejected.

## HTTP contract

Browser writes require the authenticated account/room session binding, CSRF token and same-origin write protection. Room API keys also require the applicable rooms read/write scope.

- `POST /api/account-join-requests`: `{roomId, requestId, displayName, note?}`. The client generates a `humanjoin-` request ID, at most64 characters. The name is at most80 characters and note at most1000.
- `GET /api/account-join-requests`: the authenticated account's most recent100 requests.
- `POST /api/account-join-requests/{requestId}/cancel`: `{expectedRevision}`.
- `GET /api/rooms/{roomId}/join-requests`: up to100 pending, unexpired requests for a current membership administrator.
- `POST /api/rooms/{roomId}/join-requests/{requestId}/decide`: `{decision: "approve" | "deny", expectedRevision}`.
- `GET /api/rooms/{roomId}/join-settings`: current directory visibility, owner only.
- `POST /api/rooms/{roomId}/join-settings`: `{discoverable, expectedDiscoverable}`. This changes listing only and refuses a stale value.

Responses omit the private account identifier and request fingerprint. Account deletion removes the account's request rows and membership bindings through the existing deletion inventory; historical room event retention follows the existing policy. No email is sent.

## Schema and recovery qualification

Schema43 adds `account_join_requests` and its indexes. The migration installs the43 writer fence atomically. Schema42 writers must fail after migration; deploying an unchanged42 runtime is not a supported rollback.

Before release, qualify a43-aware fallback based on the prior production behavior. It must include the additive table/index definition,43 fence and request deletion compatibility, while retaining prior UI and route behavior. Persist pending, approved and denied requests and approved human memberships; run candidate → fallback → candidate restart tests and verify those records and existing room behavior. A fallback must not approve, cancel or discard requests automatically. Ordinary rollback must not restore an older snapshot or lose data.

Current implementation is under qualification. The bounded100-item views do not yet expose pagination. Release qualification must include composed first-login/discovery UI, real Worker SQLite migration and fallback restart, authority/race tests, affected checks, lint, full suite and the required1000-message benchmark. These are requirements for this change, not claims that those checks have already passed.
