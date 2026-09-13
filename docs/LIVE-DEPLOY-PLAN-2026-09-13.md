# Live deploy execution plan — Project Room (2026-09-13)

This is the **pre-live** plan: everything that must be true before DNS points humans at this tree. It is not a feature backlog. It is not permission to `wrangler deploy` onto the live schema-26 object.

**Current facts**

| Fact | Value |
|---|---|
| Live object (do not write first) | schema **26**, `a5f2dca` |
| This tree | schema **33**, branch `codex/project-room-integration`, HEAD `3c7f1cb` |
| Staging wrangler | `getdasha.com/room*`, `workers_dev: true` |
| Production stub | `cloudflare/wrangler.production.jsonc` — `ROOM_ORIGIN=https://room.trydemigod.com`, `ROOM_PRODUCTION=1`, **no secrets** |
| Public MCP | `ship: false`, `persistence: none`, join `unavailable` |
| Messaging | Gmail/Telegram/Twilio **unset** at launch |
| Wrangler on this Mac | not on PATH at last check |
| Rollback | restores **Worker code**, not Durable Object SQLite |

Related: `docs/PRODUCTION-GATES-PLAN-2026-09-13.md` (gates already implemented). This document is **how to execute live**, in order.

---

## 0. Decision lock (do not skip)

Before any Cloudflare write:

1. **Host name.** Production origin is `https://room.trydemigod.com` unless John writes a different exact origin. Marketing pages (trydemigod.com www) are **not** the Room Worker.
2. **One object.** One Durable Object class `ProjectRoom`, one sqlite. Gradual deploys pin **one Worker version per object**, not per request.
3. **Copy first.** Never open this tree against live `a5f2dca` until a clone has passed the drill.
4. **No messaging env.** Do not set Gmail/Telegram/Twilio secrets at launch.
5. **No public MCP join.** `openJoinContract().ship` must stay `false`.

If any of those five is unclear, stop. Do not “try production against live to see.”

---

## 1. What is already done in this tree (do not redo)

| Piece | Where | Proof |
|---|---|---|
| Clerk fail-closed | `server/production-gates.mjs`, wired in `server.mjs` + `cloudflare/room.mjs` | `tests/production-gates.test.js` |
| Operator `idp-` → Welcome `manage_members` | `loginWithProvider(..., operatorAccountId)` | `tests/provider-operator.test.js` including real HTTP POST `/api/provider-session` |
| Grant journal dump/restore | `Inbox.dumpJournal` / `restoreJournal`; CLI `scripts/maintenance-inbox-backup.mjs` | `tests/inbox-journal-backup.test.js` |
| Loopback two-human drill | `scripts/hosted-drill.mjs` | `tests/hosted-drill.test.js` (refuses `ROOM_DRILL_ALLOW_LIVE=1`) |
| Copy-first sqlite cutover | `scripts/cutover-copy.mjs` | `tests/cutover-copy.test.js` (refuses `a5f2dca` in path) |
| Production wrangler stub | `cloudflare/wrangler.production.jsonc` | no `pk_live_` / PEM in file |
| Public open-join | `GET /api/open`, `/.well-known/mcp.json` | `tests/production-http.test.js` |

Do **not** re-litigate these as launch blockers. They are local proofs, not hosted proofs.

---

## 2. Execution sequence (strict order)

### Phase A — Freeze the candidate (local, no Cloudflare)

A1. `git status --short` on `project-room-integration`. Do not commit `.gitignore`, `.wrangler/`, or the four research `docs/*RESEARCH*` files unless John owns that change.

A2. Record candidate SHA: `git rev-parse HEAD`. Stamp is already in `/api/version` `sourceRevision`.

A3. Re-run the gate pack:

```bash
cd ~/src/project-room-integration
node --test tests/production-gates.test.js tests/provider-operator.test.js \
  tests/inbox-journal-backup.test.js tests/hosted-drill.test.js \
  tests/production-http.test.js tests/cutover-copy.test.js
node scripts/hosted-drill.mjs
```

A4. Confirm `openJoinContract().ship === false` in source (`server/open-contract.mjs`).

Exit Phase A only if all of that is green.

### Phase B — Secrets and DNS (John + Cloudflare dashboard)

B1. **Clerk production instance** (not `*.clerk.accounts.dev` for the live origin):

- Issuer `https://clerk.trydemigod.com` (or the exact production issuer already verified).
- Publishable key `pk_live_…` whose payload decodes to `{issuer host}$`.
- RSA-2048 public key PEM for networkless verify (`ROOM_CLERK_PUBLIC_KEY`).
- `authorizedParties` = exact `ROOM_ORIGIN` (no trailing slash drift).
- Session JWTs are short-lived; refresh is a new verified exchange (already implemented).

B2. **Operator account id.** After one Clerk user exists, compute `idp-` + sha256 hex of `JSON.stringify([issuer, sub])`. Put that in `ROOM_OPERATOR_ACCOUNT_ID`. Never email.

B3. **Wrangler secrets** (not git):

```text
ROOM_CLERK_ISSUER
ROOM_CLERK_PUBLISHABLE_KEY
ROOM_CLERK_PUBLIC_KEY
ROOM_OPERATOR_ACCOUNT_ID
```

`ROOM_ORIGIN` and `ROOM_PRODUCTION=1` are already vars in `wrangler.production.jsonc`.

B4. **DNS + TLS** for `room.trydemigod.com` (or the chosen host). Do not attach the production Worker to `getdasha.com/room` routes from staging `wrangler.jsonc`.

B5. **Install wrangler** on the machine that will deploy (`npx wrangler` is enough). Confirm `wrangler whoami` against the account that owns the live object.

### Phase C — Copy, never live (storage)

C1. In Cloudflare dashboard: identify the **live** Durable Object for schema-26 `a5f2dca`. Bookmark **PITR** (SQLite-backed DOs, last 30 days).

C2. Export or clone storage to a **new** object / sqlite file. Do not run this tree’s `RoomStore` against the live binding yet.

C3. Local analogue (already in tree):

```bash
node scripts/cutover-copy.mjs /ABS/source.sqlite /ABS/dest.sqlite
node scripts/maintenance-inbox-backup.mjs dump /ABS/dest.sqlite /ABS/inbox-dump.json
```

`cutover-copy` refuses any path containing `a5f2dca`. That is intentional.

C4. If the clone has **legacy automation / request_run / attachment fields**, `RoomStore` throws `Legacy … require operator reconciliation`. That is a **hard stop**. Do not force-upgrade. Reconcile or keep schema-26 until reconciled.

C5. Open the clone with this tree. Confirm `PRAGMA user_version = 33`. Confirm grant journal dump is non-empty if the clone had grants; event JSONL still omits grant bodies.

### Phase D — Hosted drill on the clone (still not public DNS)

D1. Bind the **clone** object to a preview Worker using production secrets. `workers_dev: false` for the real name; a **preview hostname** is allowed for the drill.

D2. Two browsers, two Clerk users:

- Alice = `ROOM_OPERATOR_ACCOUNT_ID` → Welcome `manage_members`.
- Bob = other sub → Welcome `permissions: []`.
- Bob posts a chat message; Alice sees it.
- Hard refresh both.
- Alice refresh must **not** extend Bob’s session expiry.
- Deactivate Bob; Bob cannot post; Alice can.

Loopback proof: `node scripts/hosted-drill.mjs` (already). Hosted proof: same assertions against the clone URL.

D3. Operator mints **one** agent (Contribute or Max). Agent posts chat. Confirm Max cannot `manage_members` / `decide`.

D4. `GET https://<clone>/api/open` → `ship: false`, `persistence: none`.  
`GET /.well-known/mcp.json` → same.  
`POST /mcp` does not persist `oa1.` membership.

D5. `GET /api/version` matches the candidate SHA.

If any D step fails: **do not** point production DNS. Rollback Worker **code** if needed; SQLite on the clone is disposable.

### Phase E — Cut public DNS (point of no return for traffic)

E1. Second PITR bookmark on the **clone that passed D**.

E2. Deploy Worker **code** in a **separate** change from any Durable Object **class** migration. Class lifecycle cannot roll back.

E3. Attach `room.trydemigod.com` (or chosen host) to that Worker. Do not dual-bind staging `getdasha.com/room` to the same object.

E4. Repeat D2–D4 on the public host with two humans.

E5. Messaging env remains **unset**. Public MCP join remains unpublished.

### Phase F — After live is stable (not blockers)

- PITR restore drill documented with a timestamp.
- Grant journal backup cron on a **copy** (`maintenance-inbox-backup.mjs`), not as a public HTTP route.
- Only then consider Gmail/Telegram/Twilio env, still copy-first.

---

## 3. Cloudflare-specific landmines

- **One version per DO.** A mixed-version fleet is not how DOs work. Plan a single candidate.
- **Rollback ≠ un-migrate.** If schema 33 writes land on the live object, rolling back the Worker leaves 33 data. PITR is the undo.
- **Class migrations.** `new_sqlite_classes` already ran for staging (`room-sqlite-v1`). Do not invent a second class for production “to be safe.”
- **CPU limit.** Production stub keeps `cpu_ms: 50`. Heavy import/export belongs in maintenance scripts, not request path.
- **gzip / 308 leftovers.** After deploy, confirm `/api/open` is 200 JSON, not a leftover 308 to Webflow.

---

## 4. Clerk-specific landmines

- `pk_test_` is **rejected** on HTTPS production origin (`provider-config.mjs`). Do not “temporarily” use test keys on `room.trydemigod.com`.
- Partial Clerk env (issuer without PEM) throws. That is fail-closed, not a bug.
- Email is not an account id. Operator is `idp-<hex>` only.
- Do not put JWKS URL in the JWT (`jku` rejected).

---

## 5. MCP-specific landmines (OWASP / spec 2025-11-25)

- HTTP MCP **SHOULD** be an OAuth 2.1 resource server before tools mutate. Room’s unpublished join is the correct launch posture.
- Origin check first; untrusted Origin **403**; echo allowed Origin; `Vary: Origin`. Do not “fix CORS” with `*`.
- Do not persist `oa1.` until abuse/moderation and identity lifecycle exist.
- Private tools stay unlistable on public `/mcp`.

---

## 6. What must NOT be done before live

| Action | Why |
|---|---|
| `wrangler deploy` of this tree onto `a5f2dca` | Schema 26 vs 33; rollback will not un-migrate |
| Commit Clerk PEM / `pk_live_` | Secrets |
| Set Gmail/Telegram/Twilio env | Not launch; local-pilot only |
| Flip `ship: true` | Unauthenticated MCP catalogs are a known internet hazard |
| Dual-bind staging `getdasha.com/room` and production origin to one object | Mixed traffic, mixed origin |
| HTTP import of event JSONL as “backup” | Drops `private_inbox_*`; route stays 409 |
| Publish `welcome-host` key | Operator path exists so you do not need that |
| Print DIE on www | Product rule |
| Merge Desk / Dasha / overlay into this Worker | Separate engines |

---

## 7. Collision / who does what

| Who | Before live |
|---|---|
| **John** | Host name, Clerk secrets, DNS, PITR bookmark, two-human hosted drill, go/no-go |
| **Grok (this tree)** | Local gates, tests, copy-first scripts — **no live DO** |
| **Instinct** | GitHub #11 / dasha-lobby — do not take |
| **Jill / Muse** | No Room key in chat |
| **Claude Tag** | `project-room-lab/` spec only |
| **Codex** | Yield if they return and claim files |

Occupancy: `git status --short` + board row. Do not commit dirty research docs or `.wrangler/`.

---

## 8. Go / no-go checklist (print and tick)

- [ ] Candidate SHA recorded; gate tests green
- [ ] `ship: false` in source and on `GET /api/open`
- [ ] Clerk production issuer + `pk_live_` + PEM in **secrets**, not git
- [ ] `ROOM_OPERATOR_ACCOUNT_ID` is `idp-` + 64 hex
- [ ] PITR bookmark on live schema-26
- [ ] Clone upgraded to 33 **without** legacy-field throws
- [ ] Inbox journal dumped from clone
- [ ] Two-human drill on **clone** URL
- [ ] One Max/Contribute agent posts; no `manage_members`
- [ ] Worker deploy **separate** from any DO class change
- [ ] Public origin returns `/api/version` = candidate SHA
- [ ] Messaging env unset
- [ ] John says go

If any box is open, it is not live yet.

---

## 9. If something fails after DNS

1. Do not “fix forward” on the live sqlite without a new PITR bookmark.
2. Roll back **Worker code** only if the data schema is still 26.
3. If schema 33 already wrote: restore from PITR to a **new** object, drill again, then retarget DNS.
4. Grant journal is not in event export — restore inbox dump if grants matter.

---

## 10. Immediate next action (no John required)

Keep local proofs green; do not deploy. The next **John-required** step is Phase B (Clerk secrets + DNS + wrangler login) and Phase C (PITR + clone). Until those exist, there is nothing honest left to “deploy live.”
