# Project Room implementation handoff

Status: local candidate only, not integrated, deployed, or product-qualified.
Branch: `codex/project-room-identity-scope`.
Checkout: `/Users/johnpotter/src/project-room-identity-scope`.
Base: `ff7365e01e59398b29c05251164bf68947c7cd9f`.

The full product goal remains active. The product-buildout roadmap in the canonical
checkout remains the long-term scope; these repairs do not replace it.

## Local change stack

| Commit | Change | Evidence document |
|---|---|---|
| 45beb1c | Relink applies requested scope, returns effective permissions, rolls back atomically | IDENTITY-RELINK-SCOPE-2026-09-12.md |
| 9fefe6e | Shared session authorization, concurrency/takeover, budget/halt and enforcement metadata policy | SESSION-COMMAND-POLICY-2026-09-12.md |
| e2ab723 | Exact retries precede budget side effects; changed payload conflicts | SESSION-RETRY-INTEGRITY-2026-09-12.md |
| 06ad661 | Cumulative spend cannot decrease; forced stop retains reported overage | SESSION-SPEND-INTEGRITY-2026-09-12.md |
| 0e65ac5 | Bearer-only credential guidance, public auth exceptions, invitation routes | OPENAPI-AUTH-SAFETY-2026-09-12.md |
| 1031c57 | Static diagnostic route templates and distinct-room retention bound | DIAGNOSTIC-BOUNDARIES-2026-09-12.md |
| c9e0341 | Thread reads use common auth and read quota | THREAD-AUTH-BOUNDARY-2026-09-12.md |
| 770c733 | Release stamp requires pristine real HEAD and safe label serialization | RELEASE-STAMP-SAFETY-2026-09-12.md |
| 06609fb | Online history import refused; export preserved | ONLINE-IMPORT-SAFETY-2026-09-12.md |
| 0794dfa | No inferred presence dots; qualified Done vs neutral Result posted; less copy | PEOPLE-RAIL-TRUTH-2026-09-12.md |

This handoff's accompanying cleanup removes the unused presence-inference
functions, imports and dot styles, and changes tests that previously asserted
those misleading implementation details. The browser test asserts dots are absent.

## Coordination and integration

Canonical `/Users/johnpotter/src/project-room` contains other agents' edits.
Do not overwrite it or cherry-pick blindly. Grok owns MCP/public-preview files
and separate G2/G3 tests. Its HTTP changes overlap the file, not necessarily the
same route blocks: preserve both sets and test the combined result in a fresh
integration worktree. Reread the board and bus before claiming that work.

Independently replayed G2 against isolated store plus canonical HTTP: five tests
passed, with coverage limitations returned to Grok. G3 confirmed invitation audit
failure; its original after-revocation export did not prove stale recovery safety.
The follow-up stale-snapshot probe independently passed 2/2 and reproduced active
membership with no identity link after legacy import. None is a production
restore, portable CI suite, or comprehensive security assessment.

## What remains unresolved

1. Recovery: fresh isolated restore, external authority witness, all authority-table
   reconciliation, credential invalidation/rotation, cutover and rollback evidence.
   Internal legacy import remains unsafe and unqualified; HTTP now blocks it.
2. Release: final bundle hashes, ignored/generated/dependency bytes, immutable
   build candidate, test-to-artifact binding, hosted receipt comparison. A clean
   stamp alone does not establish provenance. Archive stamping needs a verified
   manifest path; do not restore arbitrary revision overrides.
3. API/discovery: full route/auth/schema parity, detailed response contracts,
   browser invitation table accuracy, independent pinned MCP conformance,
   truthful public capabilities and public/private separation. No AEO guarantees.
4. Agents: external process cancellation acknowledgments, reported-vs-verified
   billing, start-spend semantics, lifecycle rotation/revocation/expiry matrices,
   and cross-runtime/concurrent-client qualification.
5. Product: simplify first-run/invite/return flows, accessible keyboard/touch
   journeys, search/attachments/knowledge reuse, review and catch-up quality,
   notification restraint, measurable value and ethical growth loops.
6. Enterprise: actual identity/admin requirements, tenant isolation, durable audit
   and retention, backup/recovery operations, support playbooks and pilot evidence.
7. Human evidence: physical devices, assistive technology, real users, retention,
   customer outcomes and owner risk acceptance are still missing.

## Next concrete work

- Review the complete change stack and Grok's latest MCP patch in an isolated
  integration checkout; resolve overlap and rerun exact-state checks.
- Bind test/build receipts to that candidate's bytes before any publication ask.
- Build a qualified offline recovery workflow; disabling online import is only
  the immediate guard, not recovery completion.
- Extend browser review from People to invitation, first message, agent connection,
  result review and returning-user catch-up. Remove redundant chrome/copy only
  while retaining scope, errors, consent, attribution and accessibility.

## Current verification

Final cleanup focused checks: 22 passed, zero failed/skipped.
Fresh final-code `node scripts/check.mjs`: 1,165 passed, zero failures/skips,
test duration 62,729 ms. Chromium People rail desktop/mobile: one passed, zero
failures/skips, 1,469 ms. Source scan finds no remaining memberPresence,
presenceLabel, presence-dot or inferred-online timeout in src. Diff check passed.
No deployment, paid execution, external messaging, credential rotation, data
deletion, or live restore was performed. Request the relevant authority before
any such step. Keep the broad goal active.
