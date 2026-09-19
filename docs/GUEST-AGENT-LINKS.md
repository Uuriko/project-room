# Guest invites (owner-issued)

10 September 2026. The one-word vocabulary for this whole area is in
[docs/JOINING.md](JOINING.md): this mechanism is a **guest invite** — a
short-lived invite for an agent that should not receive a human invite link
or a durable enrolled key.

## Why a third invite kind

Packet works today with no account. Enrolled keys need an owner in the browser.
A guest invite is for an agent that can call HTTPS but holds no standing
credential. Do **not** redeem a human invite link as an agent credential. Do
**not** join a human invite link as an agent.

## Contract (v0, live — owner-issued)

| | |
| --- | --- |
| Status | `live` — mint is owner-issued. No schema / writer bump |
| Join URL | `#agent-join/<token>` — never the human invite URL |
| Token | an opaque guest-invite token (43 base64url chars with an internal prefix the server checks). Human invite tokens stay exactly 43 chars with no prefix. |
| Member | `kind: "agent"` |
| Access | read + chat (`permissions: []`) |
| TTL | 2 hours from mint. An expired invite cannot authenticate. The next owner mint deactivates the roster member |
| Account | not required for the agent |
| Max live | 10 guest members per room |
| Schema | none — reuses `credentials` + `member.added` |

HTTP:

- `GET /api/guest-agent-links` — public contract (`mint: "owner_issued"`)
- `POST /api/rooms/:room/guest-agent-links` — owner mints (Bearer access key or owner browser session)
- `POST /api/guest-agent-links` — same, with `roomId` in the body. No credential → `401 unauthenticated` (`next` points at owner mint / Add agent)
- `POST /api/guest-agent-links/preview` — rejects human tokens (`wrong_link_kind`); unknown/expired → `410 link_unavailable`. No people-data
- `POST /api/guest-agent-links/join` — same lookup; returns `memberId` + access. Does not enroll strangers

`POST /api/share-links/preview` and `join` reject guest-invite tokens with `wrong_link_kind`.

Mint body (exact known fields): `requestId`, `linkToken` (the guest invite
token), `expectedOwnerRevision`, optional `displayName` (default `Guest
agent`). The owner generates the secret; the server stores only its hash and
returns the same token on an identical retry.

The minted token **is** the access credential (`Authorization: Bearer <token>`).
The Node client accepts it.

## What this is not

- Not anyone-with-the-link redeem. That needs a link table + writer bump (held off so contribution trees stay untouched).
- Not auto-enroll. A stranger POSTing without the owner credential cannot join a private room.
- Not a human invite link, remote MCP/OAuth, or a merge into `share_links`.
- Not people-data: preview/join return room id/title and access text only (join also returns the agent `memberId`).

## Follow-up

Anyone-with-link table, writer bump, one-time redeem that is not the access key, and expiry that ends the member in the same request as the failed redeem.
