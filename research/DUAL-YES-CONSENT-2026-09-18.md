# Dual-yes consent ledger

**Purpose:** Local disk system-of-record for mutual company+talent approve before any intro. Not email. Not people CRM.

## Honesty

- Lightfield `companies/lightfield/dual-yes.json` is a **SYNTHETIC dry-run** seeded from `fixtures/opt-in-pool.json` (`dataMarker=SYNTHETIC`).
- **Do not claim live talent** or real dual-yes outreach from this demo.
- Identity / contact values are **never** stored as email/phone/linkedin in the ledger — opaque `handleRef` only.
- Policy: `identityReveal=after_dual_yes`. Intro unlock refreshes `intro-draft.md` only; `send_intro` stays kill-switched.

## Stages

`request_drafted` → `consent_requested_pending` → `talent_yes` / `founder_yes` → `dual_yes` → `intro_unlocked` (or `revoked` on any no)

## Operator steps

```bash
cd /workspace/phase0-publish/die-packet-brief-status

# Init from opt-in pool row (SYNTHETIC or FIRST_PARTY)
node scripts/dual-yes-ledger.mjs --init --slug lightfield --opt-in <uuid>

# Record decisions (audit timestamped)
node scripts/dual-yes-ledger.mjs --record --slug lightfield --actor talent --decision yes
node scripts/dual-yes-ledger.mjs --record --slug lightfield --actor founder --decision yes
# → stage=dual_yes when both yes

# Unlock intro draft only (NEVER sends)
node scripts/dual-yes-ledger.mjs --unlock-intro --slug lightfield
# → refreshes intro-draft.md; send_intro still blocked

# Guard
node scripts/dual-yes-ledger.mjs --check
```

## Files

| Path | Role |
|------|------|
| `schemas/dual-yes-consent.schema.json` | Schema |
| `scripts/dual-yes-ledger.mjs` | State machine CLI |
| `companies/<slug>/dual-yes.json` | Per-company ledger |
| `fixtures/opt-in-pool.json` | Opt-in rows (SYNTHETIC until form live) |

## Refuse forever

People-broker fields (email/phone/linkedin URLs of people), auto-send consent/intro, inventing FIRST_PARTY rows from scrape.
