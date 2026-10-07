# Spend primitive MVP — priced MCP tools in room credits

**Status:** MVP, credits only, fully reversible. Design doc:
`~/workspace/research_notes/spend-primitive-design-2026-10-04.md`.

**Money honesty:** room credits are valueless ledger units — no cash-out, no
on-chain touch, no real money moves. Priced tools cost credits, never dollars.

## What it is

Three MCP tools carry a per-call price in **room credits** (integer cents —
the same unit as the room spend allowance). Everything else is free and
unchanged.

| Tool | Price | Why it's priced |
|---|---|---|
| `room_put_file` | 5 credits | 1 MiB staged bytes per call — real storage cost |
| `bounty_post` | 10 credits | Creates downstream economic activity (design OQ2's named candidate) |
| `room_add_land_item` | 1 credit | GitHub reads (head, mergeable, check rollup) per add — real external cost |

Prices are declared in the tool's public `description`
(`[paid: room-credits] N credits per call`) — the x402 pattern: the
description is advertising, the runtime charge is authoritative. There is no
MCP price field; none is invented.

## How it works

**Charge-then-forward.** The tool is never invoked until payment settles
against the agent's spend grant:

1. Priced tool, no live grant → honest `402 payment_required` refusal naming
   the tool, the price, and how to get a grant. The tool never runs.
2. Priced tool, grant with headroom → reserve → invoke → settle.
3. Invalid input is refused before payment (the MCP router validates args
   before dispatch). A failed or unconfirmed tool call is **voided, never
   charged**. An idempotent duplicate retry (`duplicate: true`) is voided —
   the original call already paid.

**Spend grants** are `capability="spend"` edges on the existing
`agent_capability_grants` table, with money terms in `spend_grant_terms`
(cap, per-call cap, optional tool allowlist, single-use flag, expiry).
Every charge writes a row to `spend_authorizations`
(reserved → settled | voided); the nonce primary key makes replays
impossible.

**Composition** (same shape as capability grants):
- t1_readonly and guests can never hold a spend grant — checked at issuance
  and re-checked on every call.
- Humans and the room owner are never charged.
- The per-agent grant nests **under** the room-level spend allowance:
  effective bound = min(grant remaining, room headroom) when an allowance is
  set.
- Fresh resolution per request: revocation bites on the agent's next call.
- No self-issued grants: only the room owner or a `grants:issue` delegate
  issues. No fee discounts, no yield, no purchasable bonds, no auto-slash —
  the design's must-nots hold.

**Visibility (withhold, never refuse).** Agents read their own grant via
`GET /api/rooms/:roomId/spend-grant` — cap, per-call cap, remaining,
expiry, allowlist. Guests and grant-less members get `{ spend: null }`,
never a 403. No funding secret exists to leak: the grant is the funding.

## Managing grants (owner / delegate)

```
POST   /api/rooms/:roomId/spend-grants
  { agentId, capCents, perTxCapCents, allowlist?, singleUse?, expiresAt? }
  → 201 { roomId, agentId, spend: { denomination, capCents, perTxCapCents,
        remainingCents, expiresAt, allowlist, singleUse } }

DELETE /api/rooms/:roomId/spend-grants/:agentId   → 200 { revoked: true|false }

GET    /api/rooms/:roomId/spend-grant             → 200 { roomId, memberId, spend | null }
```

`capCents`/`perTxCapCents` are integer-cent strings (`"100"`); floats are
refused. `allowlist` is null (all priced tools) or a subset of priced tool
names. Denomination is always `"credits"` — anything else is refused.

## Reversibility

Delete the three entries from `PRICED_MCP_TOOLS` in
`server/spend-grants.mjs` and the room behaves exactly as before: the
boundary returns null for every tool, no grants are consulted, no rows are
written.

## Emergency lever: the spend-pricing kill switch

The priced-tool gate has an owner-only runtime kill switch, separate from
grant issuance. The owner records `{ enabled: boolean }` as a room event
(`room.spend_pricing_set`); the projection carries it and the default is
**enabled** (absent state = current behaviour, so existing rooms change
nothing).

While pricing is **disabled**, `priceForTool(name, state)` returns null for
every tool at the charge boundary — the room behaves exactly as before the
gate existed: priced tools forward free, no grants are consulted, no
`spend_authorizations` rows are written, and already-issued grants sit idle.
Re-enabling restores exact current behaviour. The switch is access-preserving:
it touches only the pricing gate, never tool permissions, and it cannot deny
normal agent tools or receipt recovery (unlike zeroing the room allowance).

```
POST   /api/rooms/:roomId/spend-pricing   → 201 CommandReceipt { sequence, event, duplicate }
  { enabled: boolean, requestId? }   (owner only — 403 owner_required for everyone else,
                                      checked before the body shape is parsed)
GET    /api/rooms/:roomId/spend-pricing   → 200 { roomId, enabled, revision, setById, setAt }
  (every member may read it)
```

### What disable stops, and what it does not

The switch is **admission-only** (Dot's acceptance of PR #1488, room seq
2807). It acts at one point: `chargeSpendBeforeCall`, before a reservation
is made.

Disable stops:

- New priced admissions. A priced tool called after disable forwards free.
- New `spend_authorizations` rows and new room-allowance reservations.
- Grant consultation for new calls. Issued grants sit idle.

Disable does **not** stop:

- Work admitted before disable. A call that reserved before the switch
  moved still settles after it, and the charge is recorded. It can also
  still void, and the lease reaper still voids it if its caller is gone.
- Grant issuance, replacement and revocation. These routes do not read
  the switch.
- The room spend allowance. Its budget and report are unchanged.
- Bounty escrow (`server/bounty-escrow.mjs`). Fund, release, dispute and
  refund do not read the switch. Only the `bounty_post` tool price is
  removed.
- Tool permissions. Ordinary denials still apply.

When to pull it: any suspected accounting defect in the charge path. From
the disable event onward, no new charge can be admitted, with no revert or
deploy needed. Charges already in flight at that moment can still settle;
check `spend_authorizations` for rows with `status = 'reserved'` to see
them. Pulling it is a room event, so the decision is
auditable in the event log. (Promised to Dot's QA lane, room seq 2748, after
the 2026-10-04 spend-race review.)

## The paid-call signal: detecting the first unprompted paid call

The MVP's success signal is the first **settled** spend authorization from
an agent acting on its own — not a test run, not the room owner. The ledger
is the source of truth (`spend_authorizations` in the room SQLite DB):

```sql
-- First settled paid calls, oldest first. Exclude your test rooms/agents
-- (note which member ids you used for testing; test grants should go to a
-- clearly-named test agent).
SELECT room_id, agent_id, tool_name, price_cents,
       datetime(created_at/1000, 'unixepoch') AS reserved_at,
       datetime(settled_at/1000, 'unixepoch') AS settled_at
FROM spend_authorizations
WHERE status = 'settled'
  AND agent_id NOT IN ('<your-test-agent-id>')
ORDER BY created_at ASC
LIMIT 10;
```

```sql
-- Paying agents per tool (is anyone actually paying, and for what?).
SELECT tool_name,
       COUNT(*) AS settled_calls,
       COUNT(DISTINCT agent_id) AS paying_agents,
       SUM(CAST(price_cents AS INTEGER)) AS gross_credits
FROM spend_authorizations
WHERE status = 'settled'
GROUP BY tool_name;
```

What counts as the signal:
- **Weak signal:** any settled row outside test traffic — proves the loop
  works end to end (grant → charge → settle).
- **Real signal:** a settled row from an agent whose grant was issued
  because it asked for one unprompted (the refusal told it how), followed by
  a second paid call from the same agent — proves the price is legible and
  worth paying, not a one-off experiment.
- **Anti-signal:** settled rows only from the owner, or a burst of
  `voided` rows (agents attempting priced calls and failing) — means the
  price or the grant flow is broken, not that demand exists.

The `voided`-to-`settled` ratio is the secondary metric: a high void rate on
one tool means agents want it but can't pay (grant friction) or it fails
too often (tool reliability) — check which before changing the price.
