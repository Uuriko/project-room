# Hosted denial conformance (isolated)

Grok isolated package. Sibling of [`conformance-pilot/`](https://github.com/Uuriko/project-room/pull/22), which stays the Instinct **#8** skeleton. This folder pins draft **[PR #23](https://github.com/Uuriko/project-room/pull/23)** and documents the hosted revocation / denial gap.

**Does not edit** Phase 0 / Codex paths: `server/http.mjs`, `server/store.mjs`, `server/share-links.mjs`, `src/app.js`, `cloudflare/room.mjs`, `cloudflare/hosted-check.mjs`. Does not merge #8, #9, or #23. Does not deploy, change DNS/routes, or spend.

## Pin

| Field | Value |
| --- | --- |
| Pull | [#23](https://github.com/Uuriko/project-room/pull/23) |
| Branch | `codex/unified-local-20260907` |
| Tip SHA | `2dcf3deeaf3dc2b897eb39617c43c6efb9f11a49` (re-fetched 2026-09-08; live #23 head) |
| Staging | `https://project-room-staging.getdasha.workers.dev` |
| Health | `GET /api/health` → 200 `{ status: "ok", mode: "cloudflare-staging" }` |
| Ready | `GET /api/ready` → 200 `{ status: "ready" }` |
| Bare `/health` | 404 `{ error: { code: "not_found" } }` |

Not Instinct #8.

## Gap vs `cloudflare/hosted-check.mjs`

On the #23 tip, `hosted-check.mjs` covers real HTTPS **join** and `--return` reconnect (plus optional `--work` / `--invite-user`). It does **not** assert cancelled, expired, join-cap, removed-member, or signed-out 401 denial on the hosted origin.

Local `#23` coverage already exists:

- `tests/share-links.test.js` — join cap, expiry, cancel, issuer-authority change, guest cannot administer
- `tests/acceptance-fixture.test.js` — expired / cancelled / full preview
- `tests/share-link-ui.test.js` — copy / retry honesty
- `tests/invitation-http.test.js` — HTTP 401 / 403 envelopes

This package records those **status/copy contracts** as fixtures so the hosted gap stays reviewable without importing Phase 0.

## Matrix

| Case | Expected | Local | Hosted-check |
| --- | --- | --- | --- |
| cancelled | 410 `link_unavailable` — “This link has expired, been cancelled, or reached its join limit. Ask for a new link.” | yes | missing |
| expired | same 410 / copy | yes | missing |
| join-cap | same 410 / copy | yes | missing |
| removed-member | 403 `access_denied` (account session) / 401 after room-credential revoke | yes (store) | missing |
| signed-out 401 | 401 `unauthenticated` on Room read after sign-out | yes | operator-once, not encoded |

Invite-only production security is unchanged. A link is never recovery for another account. Removed membership is not recreated.

## Opt-in hosted stub

`runHostedDenialHarness()` **skips** unless `HOSTED_DENIAL_RUN=1`. If that flag is set without `HOSTED_DENIAL_OPERATOR_TOKEN`, it still skips and **never invents a token**. Even with a token, the stub **refuses** to send join / cancel / expire / remove-member probes at staging.

Operator-owned evidence, if any, stays in the private `cloudflare/.operator/` folder on the #23 lane.

## Run

```sh
cd hosted-denial-conformance
npm test
```

Default tests are local and offline. They do not contact staging.

## Out of scope

- Editing or merging PR #8, #9, #22, or #23
- Dual-writing Instinct site Workers (`demigod-html`, `dasha-lobby`, …)
- DNS, routes, billing, owner keys, or guest invites
- Claiming a hosted denial PASS

Coordination: [issue #11](https://github.com/Uuriko/project-room/issues/11). Merge / deploy stay with the owner.
