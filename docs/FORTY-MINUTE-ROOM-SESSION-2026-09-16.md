# 40+ minute Project Room session plan (Grok)

Written 2026-09-15. Live bar then: Worker `3ef7ea1`, GitHub `production` `fc1b23a` (audit script ahead of Worker), `/api/open` `ship: false`, Google PKCE on, `/agent.json` 200, www `/room` Join → `https://room.trydemigod.com`.

This plan is for **me**. Execute in order. Do not skip occupancy. Do not start two slices at once. Stop a slice when one user-visible sentence is true **or** the time box ends with a green `live-audit`. Total scheduled work is **52 minutes** if every box is used; wall clock with wrangler promote is often **55–70 minutes**.

## Collision protocol (every session, 4 min)

1. Read `~/src/AGENTS.md` and `~/src/AGENT-BOARD.md` (last 15 rows).
2. `python3 ~/src/demigod-site-cdn/scripts/dg-bus.py inbox grok --unread`
3. `git -C ~/src/project-room-integration status --short`
4. **Occupied — do not touch:** `.gitignore`, `.wrangler/`, `docs/AUTOMATION-DESIGN-DEEP-RESEARCH-2026-09-12.md`, `docs/CORE-PRODUCT-RESEARCH-2026-09-12.md`, `docs/DATA-ROOMS-AND-SHARED-WORLDS-RESEARCH-2026-09-12.md`, `docs/MUD-RESEARCH-AND-PRODUCT-PATTERNS-2026-09-12.md`.
5. Instinct **#197** is off this lane. Do not merge GitHub `main` (Schema 34). Do not `ship: true`. Do not add `gmail.readonly`. Do not edit Dasha `compute/`, Desk, or Demigod `docs/ops/*`.
6. Before multi-file edits: append a board row (`grok (this TUI)` · Project Room · what · off occupied · off #197) and `dg-bus.py say --from grok` packet-safe (no secrets, no keys, no OAuth client ids).
7. If Codex is on a path, **yield**.

## Live bar (must stay green)

```
cd ~/src/project-room-integration && node scripts/live-audit.mjs
```

Must be `ok: true`, no `ship` failure, Google start without `gmail.readonly`, door Join not staging, `/agent.json` named Project Room.

---

## Block 0 — Occupancy + claim (4 min)

Do the collision protocol. Capture `git status --short`. If someone else dirtied `src/app.js`, `src/client.js`, `src/channels.js`, `src/conversation.js`, `server/http.mjs`, `deploy/agent-discovery.mjs`, or `scripts/live-audit.mjs`, **stop that file** and pick a later block whose files are clean.

## Block 1 — Human + agent curl pass (8 min)

Simulate without asking John to click.

Human:

- `GET https://room.trydemigod.com/` — skip-link `#auth-title`, Continue with Google, Sign in with a key.
- `GET /api/auth/google/start` (Origin: live host) — 302 accounts.google.com, PKCE S256, no mailbox scope, Set-Cookie `__Host-account_session`.
- `GET /privacy` with `Origin: https://accounts.google.com` — 200.
- `GET https://www.trydemigod.com/room` — Join href live origin, no staging.

Agent:

- `GET /agent.json` equals `GET /.well-known/agent.json`.
- `POST /mcp` initialize without Origin — 200, join unpublished.
- `POST /mcp` with foreign Origin — 403.

If any fail, **this block becomes the slice**. Do not continue to Block 2 until live-audit is green or the failure has a failing test.

## Block 2 — Receipt sentence is viewer-honest (10 min)

**Files:** `src/conversation.js`, `tests/conversation.test.js`, maybe `src/app.js`.

Today `conversationReceiptSentence` says `waiting on you` for every viewer. Change to accept optional `viewerId`: if `nextWorkStep(item).memberId` is set and differs from viewer, use `waiting` (or `waiting on them`), not `waiting on you`. Done/failed unchanged. Title still prefixes.

Test drives `conversationReceiptSentence` with a proposed item owned by `owner` as viewer `producer` vs viewer `owner`. Assert app.js passes `session.member.id` if wired.

Do **not** invent Tree UI. English only.

If `src/conversation.js` is occupied, skip to Block 3.

## Block 3 — Unsigned `/api/session` hint is human-safe (8 min)

**Files:** `src/agent-error.mjs` **or** `server/http.mjs` only if you can keep AX for Bearer agents.

Browser `GET /api/session` without a room cookie returns 401 with hint “Ask the owner to mint a guest-agent credential”. Humans hitting that from the app should not be told to mint `ga1.`.

Prefer: if `Authorization` is absent and `Accept` is not MCP, keep `error.message` “Sign in with an active room key” and a hint that names Google or a key, not guest-agent. Agents with Bearer keep the existing AX hint.

Prove with `tests/agent-error-next.test.js` or `tests/production-http.test.js` hitting the **real** `/api/session` handler.

If this fights Instinct’s AX contract, **abort the block** and note it; do not weaken `assertAx`.

## Block 4 — DM projection empty-state (7 min)

**Files:** `src/app.js`, `src/channels.js`, `tests/channels.test.js`.

`roomMemberDirectMessages` already projects other humans. If the viewer is alone (only self + agents), the People rail should not show an empty “Direct messages” heading. Assert the helper returns `[]` when the only other members are agents or inactive. Confirm `app.js` only renders the heading when `dms.length`.

No new conversation store. No Desk merge.

## Block 5 — Clean worktree deploy only if Blocks 2–4 changed Worker assets (12 min)

If `src/*`, `server/*`, `deploy/*`, or `cloudflare/room.mjs` changed:

1. Commit only your files (not occupied).
2. `git worktree add ~/src/wt-pr-40min HEAD` (not shared `/tmp`).
3. `wrangler deploy --config wrangler.production.jsonc` from `cloudflare/`.
4. If “No targets deployed”, `wrangler versions deploy <id>@100 -y`.
5. `node scripts/live-audit.mjs` must stay green.
6. `git push origin HEAD:production`.
7. `git worktree remove --force ~/src/wt-pr-40min`.
8. Packet-safe channel: live SHA, ship false, what changed.

If only `scripts/live-audit.mjs` / tests changed, **do not** wrangler; push `production` for git.

## Block 6 — Buffer / second pass (3 min)

Re-read `git status --short`. Confirm you did not stage occupied research. If live-audit is red, that is the rest of the session.

---

## Time box sum

| Block | Minutes |
|---|---|
| 0 Occupancy + claim | 4 |
| 1 Human/agent curl | 8 |
| 2 Receipt viewer | 10 |
| 3 Session 401 hint | 8 |
| 4 DM empty-state | 7 |
| 5 Deploy + audit | 12 |
| 6 Status hygiene | 3 |
| **Total** | **52** |

Wrangler + promote often adds 5–15 min. Plan for **~60 minutes** wall clock.

## Done when

- Board row + packet-safe claim exist for the session.
- At least one of Blocks 2–4 has a committed test driving a shipped function.
- `node scripts/live-audit.mjs` is `ok: true`.
- Occupied files untouched.
- No `ship: true`, no Schema 34 cutover, no #197, no compute/ edits.

## Do not use this plan for

Desk, Dasha Compute coordinator, Demigod overlay ops packets, Tree-of-Life router, Google sign-in chrome, infinite keep-working after the time box.
