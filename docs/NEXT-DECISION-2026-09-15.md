# What to do next — decision plan (2026-09-15)

Live host is already the product. This plan is how to **choose** the next slice, not a backlog dump.

## Facts

| Thing | State |
|---|---|
| Live | https://room.trydemigod.com `d58de7e`, unpublished walk-in, keys/invites, Max agents can hold full grants |
| GitHub | `production` = live SHA; `main` = other history; no open PRs; only those two branches |
| Channels | Contract + Rooms list projection (sort only). No DM sidebar in the UI yet |
| Staging | `project-room-staging` still schema-26. Separate Worker |
| Occupancy | Skip dirty research docs / `.gitignore` / `.wrangler`. Instinct historically owns wake-queue. Tag owns sandbox |

## Decision rule

Pick **one** of A/B/C. Do not start two. Do not “also quickly” cut over `main`.

Stop a slice when: one user-visible sentence is true, a test hits the real helper or preview/API, live `/api/open` is still unpublished.

## Option A — Deepen live Room (default)

Stay on this Worker. Next slices in order:

1. **In-thread receipts** — “done / failed / waiting on you” in the conversation, using existing Work Item → Act → Event → Receipt. Highest product value.
2. **Channels DMs as projection only** — `directConversation` + sidebar section. No new auth. Stop when two members can open a DM label that maps to a room they already can access.
3. **Operator day-2** — revoke invite, rotate agent key, reconnect Max without losing chat.

Choose A unless John explicitly wants old staging data or GitHub `main` on this host.

## Option B — Staging data (optional, slow)

Export from `project-room-staging`, import into a **new** object on `project-room`. Not PITR-clone (PITR is in-place). Not deploy-this-tree-onto-staging.

Only if we need those old rooms on production. Not required for “shipped.”

## Option C — Cut over GitHub `main` (explicit only)

Hundreds of commits (inbox, Telegram, schema notes). Different history from `production`. Do this only if John says **cut over main**. Then: merge/replay, hosted checks, deploy to Worker `project-room` with unpublished walk-in still false unless he also asks to publish it.

## Explicitly not next

- `ship: true` / persist open-join
- Mix Desk, Dasha, Room
- Merge Tag sandbox into Room source
- Tree-of-Life / mystical navigation
- Redeploy Demigod HTML worker from this overlay (www `/room` Join href still needs that Worker; source isn’t here)

## Recommendation

**Do A1 (in-thread receipts).** Channels sort is enough for now. `main` cutover is a product decision, not polish.

## How we work

One sentence per change. Test the real function or UI path. Occupancy. Debate on GitHub #11 / bus; no keys in iMessage or WhatsApp.
