# Changelog

All notable changes to the spec set (`spec/`) are recorded here. The set
is versioned as a whole; the current version is **0.1.0-draft** and it is
unstable. A change that alters a normative MUST is recorded here before
it is treated as the current draft. Field meaning does not change in
place: a breaking change takes a new draft version in this changelog.
(Versioning rule: [the draft index](README.md).)

## Unreleased

Truth-layer documentation rework (batch B4). No normative MUST in the
core files changed; two absorptions moved product-model semantics into
the spec set, and one example was corrected to the kernel vocabulary.
No new version is cut by these entries.

- `core/receipt.md` absorbs `docs/ROOM-RECEIPT-V1.md`: the
  `room.receipt.v1` artifact-pack semantics (required fields, artifact
  rules, Interlateral honesty fields, receipt graph, `cua`, scorer
  append rule) now live in the receipt spec as a section distinct from
  the live board receipt. `docs/ROOM-RECEIPT-V1.md` is removed.
- `core/room.md` absorbs `docs/SPEC-v0.md`: the v0 product model
  (object meanings, work-state vocabulary, consistency, membership,
  runtime/recovery, acceptance) now lives in the room spec, marked
  where it states product intent the current server does not implement
  in that form. `docs/SPEC-v0.md` is removed.
- `docs/examples/claim.md` corrected to the kernel's seven claim
  states (`unclaimed` · `claimed` · `in_progress` · `blocked` ·
  `delivered` · `done` · `closed`, `server/work-claims.mjs`). The
  example previously used `submitted`, which is not a claim state.

## 0.1.0-draft — 2026-10-02

Initial draft of the room, claim, receipt, wake, and approval model,
plus HTTP, MCP, and A2A binding stubs. Normative statements cite the
modules on `main` that implement them. Gaps are written as Room today
notes.

Landed in commit `88b051fc4` ("Add the 0.1.0-draft spec for room, claim,
receipt, wake, and approval"). No later commit has cut a new spec
version: subsequent touches (a spec-link fix on 2026-10-03, board cap
and stale-sweep notes in `core/claim.md` on 2026-10-09, and the
`room_claim` / `room_handoff` verb notes on 2026-10-26) amended the
0.1.0-draft text in place and are part of this version.
