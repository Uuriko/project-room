# Opt-in form ship plan (trydemigod) — docs + local stub; still not deployed

**Goal:** Replace SYNTHETIC `fixtures/opt-in-pool.json` with live `FIRST_PARTY` rows from a first-party form. No people scrape. Do **not** deploy trydemigod in this fold.

Wave 2 START ([#551](https://github.com/Uuriko/project-room/pull/551)) wrote the ship plan. Wave 3 adds a **local Worker/static path stub** and an empty `FIRST_PARTY` pool. The form is still **not** hosted.

Project Room stays separate from Desk, Demigod/DIE, and Dasha.
Compute ≠ Room. DIE matching ≠ Ask.

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

## Worker + static path (next ship — docs / local stub only)

**Host (planned):** `trydemigod.com` (or Access-gated admin). **Not published from this slice.**

| Surface | Method / path | Behavior |
| --- | --- | --- |
| Static form | `GET /opt-in` | Worker assets / Pages; fields match the local form stub |
| Health | `GET /api/opt-in/healthz` | `{ ok: true, service: "demigod-opt-in", live: true\|false }` |
| Submit | `POST /api/opt-in` | Validate body → persist `FIRST_PARTY` → `{ optInId, status: "active" }` (no handle echo in logs) |

Access: Cloudflare Access or equivalent on write-admin / export; public form POST rate-limited. **No** LinkedIn OAuth scrape. **No** Apollo/People enrichment on submit. **No** wrangler publish from this fold.

### Local stub (Wave 3 — this is what exists)

| Artifact | Honesty |
| --- | --- |
| `fixtures/opt-in/form.stub.html` | Disabled controls; planned `action=/api/opt-in`; **not** hosted |
| `fixtures/opt-in/FIRST_PARTY.empty.json` | `items: []` · `live: false` until Worker intake |
| `fixtures/opt-in/worker-route.stub.mjs` | `--check` / `--dry-run-validate`; **refuses persist** |
| `schemas/opt-in-talent.schema.json` | Ready; unchanged |

Keep `fixtures/opt-in-pool.json` as `SYNTHETIC`. Do not invent live talent. Promote to `FIRST_PARTY` only after a real consent POST.

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

**First live FIRST_PARTY row** lands in the pool and replaces SYNTHETIC-only honesty. Until then: queue remains synthetic; `FIRST_PARTY` stays empty; draft factory honesty stays mid-50s (Wave 3 snapshot **~55/100**).

## Out of scope this turn

Deploy, wrangler publish, Access enable, live form HTML on trydemigod, Stripe, email send, inventing talent rows.
