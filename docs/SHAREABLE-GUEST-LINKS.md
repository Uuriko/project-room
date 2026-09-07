# Anyone-with-the-link guest access

John selected “anyone with the link” on September 6, 2026 (Pacific). This local milestone adds invitation links without sharing a member's personal access key.

## Experience

A signed-in human membership administrator chooses **Invite people**, creates a link, and copies it. Defaults: 24 hours and 10 new guests. Options: one hour, 24 hours, or seven days; 1–25 new guests. Links can be cancelled. Cancellation/expiry stops future joins, not existing memberships.

The recipient opens `/#join/<secret>`, reviews the room/history access, chooses a name, and joins. New guests receive distinct accounts and room identities with the existing conversation-only guest role. They can read room history, chat and react, but cannot administer memberships, create other links, or approve work. Names are self-selected and unverified. An existing authenticated membership is reused without consuming a join. A removed membership is never replaced just by changing its display name.

The secret is removed from the browser address immediately, held in memory, sent only in same-origin POST bodies, and stored on the server only as a hash. Copy has a select-and-copy fallback. Secret links are not recoverable from the management list; create another if lost. A link in a message to somebody is a transferable access grant, not proof of their real-world identity.

Guest access lasts up to eight hours in the current browser. Signing out, expiry, or losing cookies does not provide guest identity recovery. Rejoining after explicit sign-out creates a different guest, consumes a new use and leaves prior history attributed to the prior identity. Durable sign-in/recovery and verified names remain later work. Existing credential flows remain available.

The localhost preview works only on this Mac. It is not a remotely shareable hosted room. No publication or deployment was performed.

## Service contract

- `GET /api/rooms/:room/share-links`: authenticated human administrator metadata; no secrets.
- `POST /api/rooms/:room/share-links`: exact fields `requestId`, `linkToken` (32 random bytes, base64url), `expiresAt`, `maxJoins`, `expectedMemberRevision`. The browser generates the secret so retries need no recoverable server-side plaintext. Same request and scope return the same link; changed scope conflicts.
- `POST /api/rooms/:room/share-links-cancel`: exact `linkId`; cancellation is final and idempotent.
- `POST /api/share-links/preview`: exact `linkToken`; origin checked, rate limited, no room history or account identity included.
- `POST /api/share-links/join`: exact `linkToken`, `displayName`, UUID `redemptionId`, `expectedSessionRevision`. Requires the browser's pre-established HttpOnly account-session slot, Origin, CSRF and session binding. It does not require an account access key. Browser cookie bytes remain stable through identity creation.

Management supports the existing room or account authentication modes, with current server-side administrator permission checks. These are not automatic agents or an MCP implementation. Guest invitation links are for human browser entry; existing scoped agent credentials remain separate.

## Storage and authority

Schema v7 adds immutable link scope and append-only redemption references. The migration is in the existing single startup transaction and installs v7 writer guards, preventing ordinary writes by a previously-open v6 service. Existing v6 guards are retained and satisfied only by a compatible writer. Back up before migration. The disposable preview database was backed up before its upgrade.

The link fixes its issuer account, authentication epoch, member revision, expiry, usage ceiling, and the guest-only policy. Redemption rechecks current issuer authority. Account creation, browser identity change, ordinary account-bound invitation issuance/acceptance, room event/projection, account binding, private journal, and link usage commit together. Retries require the same current browser identity and name. No existing targeted invitation was broadened to bearer acceptance.

Every join reuses the existing full invitation evidence/journal contract. Its private `share_link_joins` reference identifies the delegated authority source. The inherited issuance audit uses session revision zero as a neutral envelope value for this delegated action; it must not be presented as proof that the inviter interactively logged in at redemption time. Its actual current authority is rechecked against the link's fixed issuer scope. The joined human remains the public join event actor. Startup validates the link-to-invitation relationship and usage count.

This is bounded local-pilot access, not production identity assurance or abuse prevention. There is no per-person join limit, email verification, durable distributed rate limiting, or protection against an administrator who can rewrite the whole database.

## Verification

Local contract tests cover distinct guests, unchanged owner identity, same-request retry, changed-name/session fencing, guest permission boundaries, link expiry/use limits/cancellation, issuer authority changes, account membership reuse, restart, all-or-nothing storage failure, HTTP cookie/CSRF/binding integration, client delayed-response ownership, and upgrade writer compatibility. The full syntax/core/API suite passed before final handoff; see the current checkpoint for the final count.

Browser access has been restored. Guest joining/chat/reaction, draft and identity preservation, owner create/copy/cancel, and narrow layouts received partial browser verification. This found and fixed hidden status feedback. The current suite passes 157 core/API checks; remaining browser acceptance is paused at John's request. See [the current checkpoint and screenshots](BROWSER-CHECKPOINT-2026-09-07.md) for exact evidence and untested cases. Earlier 28 browser checks predate these screens and are not evidence for them.
