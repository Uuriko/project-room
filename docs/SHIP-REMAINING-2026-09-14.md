# Remaining ship — 2026-09-14

Goal: keep **https://room.trydemigod.com** production-live, unpublished walk-in, local operator, no Clerk, and take **useful** work from other agents only when it does not break those gates.

## Already live (do not undo)

| Check | Expected |
|---|---|
| `GET /api/version` | `mode: cloudflare-production` |
| `GET /api/open` | `ship: false`, `persistence: none` |
| `GET /api/auth-config` | `provider: null` |
| `GET /api/ready` | 200 |
| Worker secrets | `ROOM_OPERATOR_ACCOUNT_ID` only (`c6a94a`) |
| Schema-26 object `a5f2dca` | not bound to this Worker |

Occupancy: do not edit `.gitignore`, `.wrangler/`, or `docs/*RESEARCH*`. DIE / Desk / Dasha stay other trees.

## Do not ship (explicit)

- Public MCP `ship: true` / persist `oa1.`
- Gmail, Telegram, Twilio env or live adapters
- Clerk CLI / dashboard / `clerk init` / Next.js Clerk SDK
- First schema-33 write onto live object `a5f2dca`
- Merging Tag sandbox into Room source as a second product
- Dual-binding staging `getdasha.com/room` and production to one Durable Object

## Phase 0 — Verify live (Grok)

Refresh the four GETs above after every deploy. Hosted drill and phase-a-preflight stay local. Two-human **hosted** drill on the live origin still needs a second human; not a launch blocker.

## Phase 1 — Tag useful copy (Grok, after GitHub read)

Tag ACK: sandbox `demigod-labs/claude-tag-sandbox` PR #3, wording-only journeys/copy. That repo is **private (404 without `gh`)**.

When `gh` can read it:

1. Pull PR #3. Take **user-visible copy only** (Join, invite, help, empty states).
2. Apply into `index.html` / `src/app.js` in **this** tree. No sandbox merge, no new product.
3. Keep tests that assert Join / invite still passing.
4. Do not take Tag “38 section 5” as live-system claims.

Until `gh auth login`: skip. Do not invent Tag copy.

## Phase 2 — GitHub coordination (needs John)

`gh` is not logged in. Instinct mailbox is `Uuriko/project-room#11`.

John: `gh auth login` in this environment. Then Grok comments live status on #11 (no secrets). Codex is offline; do not wait.

## Phase 3 — Schema-26 data (`a5f2dca`) copy-first (Grok + Cloudflare dashboard)

Live historical object is schema **26**. This host is a **new empty schema-33** Worker. Rollback restores code, not SQLite.

1. In Cloudflare dashboard: find the Worker that owns object id `a5f2dca`. Enable SQLite DO PITR (last 30 days).
2. Clone to a **new** object id. Never point this tree at `a5f2dca`.
3. `scripts/cutover-copy.mjs` refuses any path containing `a5f2dca`.
4. Run hosted drill on the **clone**. Only then consider a later cutover.

This phase needs dashboard PITR. CLI cannot name that object from this Worker.

## Phase 4 — Claude PR #133 Telegram inbox (do not enable live)

Useful later. Keep off production. No `ROOM_TELEGRAM_*` on the live Worker. Review only if John wants messaging after launch.

## Phase 5 — Confirm operator UX (John, 30 seconds)

Refresh https://room.trydemigod.com. You should still be **Member c6a94a** with invite / Add agent. If not, say so.

## Order

0 → 5 (John glance) → 2 when `gh` exists → 1 Tag copy → 3 PITR clone when dashboard object is identified → 4 never unless asked.

Done when: live checks still hold, Tag copy is either applied or still blocked on `gh`, `a5f2dca` untouched, messaging off, ship false.
