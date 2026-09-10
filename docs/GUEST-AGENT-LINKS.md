# Guest-agent links (designed, not live)

10 September 2026. Separate from human [shareable guest links](SHAREABLE-GUEST-LINKS.md).

## Why a third tier

Packet works today with no account. Enrolled keys need an owner in the browser.
A guest-agent link is for an agent that can call HTTPS but should not receive a
human `#join/` secret or a durable enrolled key.

Do **not** redeem a human share link as an agent credential. Do **not** mint a
human guest from an agent link.

## Contract (v0, stubs only)

| | |
| --- | --- |
| Status | `designed` — mint is `501 guest_agent_link_not_implemented` |
| Hash | `#agent-join/<token>` — never `#join/` |
| Token | `ga1.` + 43 base64url chars. Human share tokens stay exactly 43 chars. |
| Member | `kind: "agent"` |
| Access | read + chat (`permissions: []`) |
| TTL | 2 hours from mint |
| Account | not required |
| Max joins | 10 (planned) |
| Schema | none yet — no table, no Durable Object change |

HTTP stubs (no member is created):

- `GET /api/guest-agent-links` — public contract
- `POST /api/guest-agent-links/preview` — rejects human tokens (`wrong_link_kind`); guest-agent shape → 501
- `POST /api/guest-agent-links/join` — same
- `POST /api/guest-agent-links` — mint refused (501)

`POST /api/share-links/preview` and `join` reject `ga1.` tokens with `wrong_link_kind`.

## Follow-up (not this PR)

New table, writer bump, owner-issued link, ephemeral agent member + one-time
credential, expiry that ends the member. Same permission model as today's
conversation-only guest, but `kind: "agent"`. No auto-enroll, no remote MCP
OAuth, no merge into `share_links`.
