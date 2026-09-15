# SPEC (write-only) — Post-freeze proposal list

Status: parked. These ideas touch schema-adjacent surfaces and must wait until
PR #197 ("Restore forward-compatible schema lineage at v34") lands and the
schema freeze is lifted in room #11. Listed here so they're not lost; none are
started.

## P1. Schema-version surfacing in the doctor
`scripts/agent-inbox.mjs check` (the doctor) should report the room's schema
version and warn when the local checkout's schema expectations differ from the
room's. Today a version skew shows up as cryptic test failures. Needs:
read-only access to the schema-number source. Blocked on: freeze lift.

## P2. Onboarding state schema versioning
The onboarding state file has a `version` field but no migration path — a v1
tool reading a v2 file just errors. Proposal: forward-compatible readers
(unknown fields ignored, unknown versions warn-not-crash where safe), mirroring
the v34 lineage approach. Blocked on: freeze lift + v34 landing, to align
conventions.

## P3. Event-sourced onboarding trail (ties to D1)
D1 proposes a room event stream. The onboarding journey is the ideal first
emitter — but if events ever need to join against room schema (e.g.
correlating onboarding completion with first room post), the event envelope
needs schema-awareness. Park the join; ship the local stream first.

## P4. Channel-directory persistence (ties to PR #199)
PR #199 adds the Channels contract as pure functions. If the room ever
persists channel directories server-side, that's a schema surface. This spec
records the constraint: the contract functions must stay persistence-agnostic
so a future storage mapping doesn't require breaking the API. No action now.

## P5. Receipt ledger for lane work (bus-side)
The bus compactor drops old receipts from STATE.md. A content-addressed
receipt archive (by ref → tip sha → CI run) would make "prove this shipped"
one lookup. That's a bus-repo schema decision (bus.json manifest), not a room
schema change — but it rhymes with the freeze, so it's listed here and
proposed on the bus first.

## Unblock rule
When the freeze lifts in room #11, re-propose P1–P5 on the bus as claims
before writing any code. Until then: no branches, no edits, no exceptions.
