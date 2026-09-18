# Opt-in form ship plan (trydemigod) — docs only this turn

**Goal:** Replace SYNTHETIC `fixtures/opt-in-pool.json` with live `FIRST_PARTY` rows from a first-party form. No people scrape. Do **not** deploy trydemigod in this Wave 2 START task.

## Form fields (from `schemas/opt-in-talent.schema.json`)

| Field | UI | Notes |
|-------|-----|-------|
| rolesInterested[] | multi-select / tags | Required |
| workAuthUS | checkbox | Self-attest boolean |
| locationPref | text | e.g. SF Bay, remote-US |
| cheapTalkExpectations | textarea | Comp/pace/constraints — cheap talk |
| contactHandleType | select email \| x \| telegram | Channel type only |
| contactHandleValue | text | Stored encrypted / access-gated; not shown on founder desk until dual_yes |
| consentVersion | hidden | Stamp current consent copy version |
| consentedAt | server | ISO timestamp on submit |

Server adds: `optInId` (UUID), `status=active`, `dataMarker=FIRST_PARTY`. Never accept client-supplied `FIRST_PARTY` / `SYNTHETIC` spoof without auth.

## Worker route sketch

```
POST /api/opt-in
  - Validate body against opt-in-talent.schema.json (minus server fields)
  - Require consent checkbox + consentVersion match
  - Write FIRST_PARTY row to DIE/demigod-ops opt-in store (or KV/D1)
  - Return { optInId, status: "active" } — no echo of handle value in logs
GET  /api/opt-in/healthz  — form surface up
```

Access: Cloudflare Access or equivalent on write admin; public form POST rate-limited. **No** LinkedIn OAuth scrape. **No** Apollo/People enrichment on submit.

## FIRST_PARTY write path

1. Form POST → Worker validates → persists row with `dataMarker=FIRST_PARTY`.
2. Export/sync into slice `fixtures/opt-in-pool.json` **or** live path `data/opt-in-pool.live.json` (same schema).
3. `rank-from-opt-in.mjs` prefers live pool when present; refuses missing marker/consent.
4. Dual-yes ledger `--init --opt-in <id>` only for active rows.

## Privacy

- Handle values private until `dual_yes`.
- Desk/rank use roles + cheap-talk + opaque ids only.
- Revoke → `status=revoked`; ranker skips.
- No people-broker ingest; no `/in` URLs as source.

## Success metric

**First live FIRST_PARTY row** lands in the pool and replaces SYNTHETIC-only honesty. Until then: queue remains synthetic; draft factory honesty stays mid-40s.

## Out of scope this turn

Deploy, wrangler publish, Access enable, live form HTML on trydemigod, Stripe, email send.
