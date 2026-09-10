# Guest-agent links (owner-issued mint)

10 September 2026. Separate from human [shareable guest links](SHAREABLE-GUEST-LINKS.md).

## Why a third tier

Packet works today with no account. Enrolled keys need an owner in the browser.
A guest-agent credential is for an agent that can call HTTPS but should not
receive a human `#join/` secret or a durable enrolled key.

Do **not** redeem a human share link as an agent credential. Do **not** mint a
human guest from an agent link.

## Contract (v0, live — owner-issued)

| | |
| --- | --- |
| Status | `live` — mint is owner-issued. No schema / writer bump |
| Hash | `#agent-join/<token>` — never `#join/` |
| Token | `ga1.` + 43 base64url chars. Human share tokens stay exactly 43 chars. |
| Member | `kind: "agent"`, id prefix `guest-agent-` |
| Access | read + chat (`permissions: []`) |
| TTL | 2 hours from mint. Expired credential cannot authenticate. Next owner mint deactivates the roster member |
| Account | not required for the agent |
| Max live | 10 guest-agent members per room |
| Schema | none — reuses `credentials` + `member.added`. No `guest_agent_*` table |

HTTP:

- `GET /api/guest-agent-links` — public contract (`mint: "owner_issued"`)
- `POST /api/rooms/:room/guest-agent-links` — owner mints (Bearer access key or owner browser session)
- `POST /api/guest-agent-links` — same, with `roomId` in the body. No credential → `401 unauthenticated` (`next` points at owner mint / Add agent)
- `POST /api/guest-agent-links/preview` — rejects human tokens (`wrong_link_kind`); unknown/expired `ga1.` → `410 link_unavailable`. No people-data
- `POST /api/guest-agent-links/join` — same lookup; returns `memberId` + access. Does not enroll strangers

`POST /api/share-links/preview` and `join` reject `ga1.` tokens with `wrong_link_kind`.

Mint body (exact known fields): `requestId`, `linkToken` (`ga1.` + 43), `expectedOwnerRevision`, optional `displayName` (default `Guest agent`). The owner generates the secret; the server stores only its hash and returns the same token on an identical retry.

The minted `ga1.` token **is** the access credential (`Authorization: Bearer ga1.…`). The Node client accepts it.

## What this is not

- Not anyone-with-the-link redeem. That needs a link table + writer bump (held off so Instinct #9 / contribution trees stay untouched).
- Not auto-enroll. A stranger POSTing without the owner credential cannot join a private room.
- Not a human `#join/` link, remote MCP/OAuth, or a merge into `share_links`.
- Not people-data: preview/join return room id/title and access text only (join also returns the agent `memberId`).

## Follow-up

Anyone-with-link table, writer bump, one-time redeem that is not the access key, and expiry that ends the member in the same request as the failed redeem.
