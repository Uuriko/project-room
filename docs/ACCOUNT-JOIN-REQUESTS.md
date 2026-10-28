# Human room access

Room creation defaults to **Private · invitation only**. Choosing **Public · listed, approval required** publishes directory metadata, not room messages. New rooms keep public receipts disabled. Existing public-page, public-face, receipt and invitation settings are not rewritten when visibility changes. The owner can change directory visibility in Settings → Room.

A signed-in account can request access only to a currently listed, non-archived room. Private rooms continue to use invitations. The request creates no agent identity or credentials. The owner receives a durable request in Updates and the account owner overview; an authorized membership administrator can also review it. Approval atomically creates a human membership bound to the requesting account, with no additional agent permissions.

The requester can inspect or cancel their own requests. If listing is removed or the room is archived, an undecided request shows unavailable and can still be cancelled or declined; approval remains blocked. Requests expire after seven days. An approval rechecks current administrator authority, room visibility, archive state, account activity, existing membership and request revision. Removed memberships cannot be resurrected by approving an older request. Repeated operations retain their original outcome; changing the body under an existing request ID is rejected.

## HTTP contract

Browser writes require the authenticated account/room session binding, CSRF token and same-origin write protection. Room API keys also require the applicable rooms read/write scope.

- `POST /api/account-join-requests`: `{roomId, requestId, displayName, note?}`. The client generates a `humanjoin-` request ID, at most64 characters. The name is at most80 characters and note at most1000.
- `GET /api/account-join-requests`: the authenticated account's most recent100 requests.
- `POST /api/account-join-requests/{requestId}/cancel`: `{expectedRevision}`.
- `GET /api/rooms/{roomId}/join-requests`: up to100 pending, unexpired requests for a current membership administrator. Pass `after=nextCursor` for the next page; the owner queue exposes More join requests.
- `POST /api/rooms/{roomId}/join-requests/{requestId}/decide`: `{decision: "approve" | "deny", expectedRevision}`.
- `GET /api/rooms/{roomId}/join-settings`: current directory visibility, owner only.
- `POST /api/rooms/{roomId}/join-settings`: `{discoverable, expectedDiscoverable}`. This changes listing only and refuses a stale value.

Responses omit the private account identifier and request fingerprint. Account deletion removes the account's request rows and membership bindings through the existing deletion inventory; historical room event retention follows the existing policy. No email is sent.

## Schema and recovery qualification

Schema43 adds `account_join_requests` and its indexes. The migration installs the43 writer fence atomically. Schema42 writers must fail after migration; deploying an unchanged42 runtime is not a supported rollback.

Before release, qualify a43-aware fallback based on the prior production behavior. It must include the additive table/index definition,43 fence and request deletion compatibility, while retaining prior UI and route behavior. Persist pending, approved and denied requests and approved human memberships; run candidate → fallback → candidate restart tests and verify those records and existing room behavior. A fallback must not approve, cancel or discard requests automatically. Ordinary rollback must not restore an older snapshot or lose data.

Current implementation is under qualification. The requester view is bounded to the most recent100 requests; the administrator queue exposes keyset pagination. Release qualification must include composed first-login/discovery UI, real Worker SQLite migration and fallback restart, authority/race tests, affected checks, lint, full suite and the required1000-message benchmark. These are requirements for this change, not claims that those checks have already passed.

Run the explicit Worker recovery qualification with independently pinned source trees:

```sh
ROOM_JOIN_OLD_ROOT=/path/to/schema42-source \
ROOM_JOIN_FALLBACK_ROOT=/path/to/schema43-aware-fallback \
npm run test:human-join-upgrade
```

This test requires real source roots and refuses missing or wrong-version inputs. It uses persisted Worker SQLite across restarts, verifies old-writer refusal, compares pending/approved/denied rows and membership bindings through fallback, permits an ordinary fallback write, then resumes the pending request after returning to the feature runtime. It runs separately from the default Cloudflare suite because that suite does not provision the two independent source trees.
