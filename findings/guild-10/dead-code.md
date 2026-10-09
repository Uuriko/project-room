# Guild-10 dead-code findings (docs slice) — 2026-10-09

Scope: `docs/` only. "Dead" here means unreachable/unreferenced documentation
or doc references proven against `git` history and `origin/main` (a6af5f2ac at
scan time). Each claim carries its evidence. Nothing here is a guess.

## 1. Archive-link rot (verified class finding — NOT fixed, by policy)

**Claim:** 112 broken markdown links across `docs/history/` all point at files
under `research/` that no longer exist.

- Evidence: xrefs scan (x01–x05) flagged 136 broken links; re-verification at
  HEAD confirmed 112, all in `docs/history/`, top targets
  `../research/ROOM-STEALS-FULL-BUILD-2026-09-17.md` (10),
  `../research/ROOM-JEV-CODEX-SPAWN-STEAL-2026-09-17.md` (9),
  `../research/ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md` (5), plus 61 other
  `../research/*` targets. `research/` at repo root now holds 2 files
  (`SETTLEMENT-DATA-RETENTION.md`, `SETTLEMENT-OPS-RUNBOOK.md`) only.
- Root cause: commit `8b9b96691` "Make the docs tree readable and skills/ the
  only skill source (#1315)" deleted the research files; the history docs that
  cited them were not updated.
- **Not fixed deliberately:** `docs/history/` is an archive. Rewriting 112
  links in historical snapshots would falsify the record; there is no valid
  replacement target (the files are gone, not moved). Recorded here instead.
  Full list: `findings/guild-10/triage/links.json`.

## 2. Orphan-doc inventory (measured, not actioned)

- 510 docs total; 183 have zero inbound references from README.md, AGENTS.md,
  CONTRIBUTING.md, docs/INDEX.md, or any other doc (`findings/guild-10/orphan-docs.json`).
- 182 of the 183 are archives (`docs/history/`), spec series (`docs/exchange/`),
  security audits, or intentional pointer stubs — orphaned by design.
- The single thin current-doc orphan, `docs/SPEC.md` (7 lines), is an
  intentional hub pointing at `spec/README.md`, `SPEC-v0.md`, `ROOM-PROTOCOL.md`
  and `openapi.yaml` — not dead, just unlinked.
- **Verdict: no deletable dead docs proven.** The inventory is provided for a
  maintainer consolidation pass; nothing is recommended for deletion by this guild.

## 3. Dead references fixed (consistency track)

The 41 `DEAD_FILE_REF` / `REPO_PATH_MISSING` items in current (non-history)
docs resolved as:
- 5 moved-file refs → retargeted to `docs/history/*` (commit 6fdd14487).
- 3 present-tense claims about modules removed in #1315 / never merged →
  annotated with dated status notes (same commit).
- Balance: false positives of the scanner (negations — "There is no
  `server/wake-webhook-dispatch.mjs`"; example placeholders — `server/a.mjs`,
  `docs/your-file.md`; branch-qualified refs — "on the ledger branch";
  external-URL path fragments in `docs/a2a-receipt-extension.md`; folded-doc
  provenance in SWARM-PLUG-IN.md; pending-marked items in SESSION-ADAPTER.md).

## 4. Dead `scripts/room` verbs/flags (all scanner false positives)

9 "confirmed" dead verbs/flags (triaged) were all false positives on manual
review: the flags belong to sibling scripts (`room-listen.mjs --mode`,
`room-hygiene.mjs --db`, `room-guard.mjs --base`, `room-mutate.mjs --run`,
`room-roster.mjs --snippet`), one was a `git checkout --` separator, and the
`merge-queue` "verb" is a rejected-design paragraph ("Why not a lane-run bot").
No dead verbs proven.

## 5. Env vars referenced by docs but unread by code (all resolved)

21 candidates triaged; every current-doc claim verified real:
- `ROOM_RECEIPT_TOKEN` → read by `.github/workflows/rollback-prod.yml`
  ("Receipt to muse-room" step).
- `ROOM_AUTO_DEPLOY`, `ROOM_ONBOARDING_GATE` → Cloudflare worker vars asserted
  in predeploy tests (`tests/rollback-readback.test.js`,
  `tests/onboarding-probe-predeploy.test.js`).
- `ROOM_MACHINE_ENABLED` → consumed by machine-control tests/scripts.
- `ROOM_DOOR_ORIGIN` → GitHub Actions repository variable (`vars.ROOM_DOOR_ORIGIN`
  in `room-github-door.yml`, `merge-queue-receipts.yml`, `merge-queue-eject-budget.yml`).
- `ROOM_UNDER_TEST`, `ROOM_STREAM_INTERVAL_MS`, `ROOM_STAGING_ORIGIN`,
  `ROOM_BACKUPS*`, `ROOM_GMAIL_PILOT_ACCOUNT_ID`, `ROOM_IDENTITY_HASH_KEY`,
  `ROOM_SERVICE_MODE`, `ROOM_DOOR_SECRET`, `ROOM_DOOR`, `ROOM_ARCHIVED`,
  `ROOM_POLICY_SET` → all have non-doc readers.
- Remaining 2 (`ROOM_PUBLIC_LOBBY`, `ROOM_BUDGET_SET`) appear only in
  `docs/history/` archives — historical, not actionable.

**Net dead-code verdict for the docs slice: no dead modules/exports proven
deletable; one verified rot class (archive links), one measured inventory
(orphans), zero action items beyond the fixes already landed.**
