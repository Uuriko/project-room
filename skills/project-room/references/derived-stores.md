# Derived stores — one fact, one home

Every major truth-drift in this codebase's recent record lived in a
*derived store*: a table, module, or stored field that duplicates a fact
owned somewhere else, instead of deriving it from that owner at read
time. The event log itself never drifted; the copies did. This file is
the rule that keeps the next copy from being created undeclared, and it
carries the registration sweep's item for it.

## The rule

**One fact, one home.** A fact has exactly one authoritative store.
Anything else that holds the same fact is a derived store, and a derived
store may only be created with a declaration in
`scripts/derived-store-registry.json` naming:

| Field | What it must say |
| --- | --- |
| `store` | The table name, module path, or stored-field identity of the copy. |
| `kind` | `table`, `module`, or `projection-field`. |
| `sourceOfTruth` | The one authoritative home of the fact: the table, projection field, or record a reader should trust when the two disagree. |
| `mechanism` | How the copy stays honest: its derivation (what writes it, from what, in which transaction) or its conformance mechanism (what compares it against the source, when, and what happens on a mismatch). "Reconcile later" is not a mechanism. |
| `status` | `conforming`, `drifted` (observed disagreeing with its source), `unbound` (no mechanism yet), or `in-flight` (a cure is filed and the entry names it). |

A declaration with no mechanism is a confession, not a registration:
the entry still belongs in the registry (so the debt is visible), with
status `unbound` and a status note naming the cure or the reason none
exists yet.

## Sweep item 10 — derived-store declaration

The pre-flight registration sweep gains a tenth item, alongside the
store registries of item 5 (writer fence, purge registry, recovery
audit — the registrations a new *table* already owed):

> **Item 10, derived-store declaration (one-fact-one-home):** a diff
> that introduces a new derived store must declare it in
> `scripts/derived-store-registry.json` in the same diff — store
> identity, source of truth, and a derivation or conformance
> mechanism. The registry is the declaration; presence at head with
> complete fields is SATISFIED, absence or an incomplete entry is
> MISSING.

Item 5 registers that a new table exists and can be written, purged,
and recovered. Item 10 registers *why the table's contents can be
believed*. Both are owed; neither substitutes for the other.

## What counts as a new derived store (the sweep's detection)

The sweep works from diffs, statically, so it detects a deliberately
narrow mechanical shape — and says so, rather than pretending to a
semantic judgement:

- a **new table** (a `CREATE TABLE` in a store source under `server/`
  or `cloudflare/`, not present at base) whose name carries a derived
  marker as a whole word or `_`-separated segment: `mirror`,
  `projection`, `derived`, `replica`, `shadow`, `rollup`, `summary`,
  or `read_model`; or
- a **new module** (an added file) under `server/` or `cloudflare/`
  whose basename carries one of those markers; or
- a diff that **adds or edits the registry itself**, which the sweep
  validates for complete entries (so a malformed declaration cannot
  land silently).

Named limits, stated plainly:

- An ordinary new table with a plain name is *not* flagged, even if in
  some design sense it duplicates a fact. Item 5 still registers it;
  whether it is derived in substance is a review judgement the sweep
  does not automate. The narrow marker rule is deliberate: a heuristic
  that false-fires on ordinary tables would be trained out of use.
- A stored-field duplication inside an existing module or table (a new
  column that copies a fact) is not detected. The seeded registry
  contains exactly such a case (the work-item session's reported
  counters) — registered by hand, because no diff heuristic at this
  precision can see it yet.
- Editing an existing derived store's derivation code is not a new
  store and draws no charge; its status in the registry is the author's
  to keep honest when the mechanism changes.

## The seeded registry

The registry opened with the four cases that defined the failure
class, each verified against the code at the seed commit, with the
audit shorthand corrected where the code disagreed:

1. `room_public_receipts_setting` — the write-time mirror of the room's
   recorded public-receipts opt-in, read by the anonymous lot read.
   Status: drifted; the decided cure is a read-time recorded-setting
   leg, in flight.
2. `messages` — the message-rows copy of the event-journal projection.
   Status: in-flight — a parity conformance mechanism already runs at
   the seed commit; the repair work is PR #4931, whose never-repair
   class names are its own vocabulary, not base facts.
3. `work_item_session_reported_counters` — work-session usage reports
   that at the seed commit carry no attempt binding. Status: unbound;
   cure in flight as PR #4932 under Ruling 43.
4. `wake_identity_resolution` — the wake path's first-row identity
   lookup, a weaker second reading of the `identity_links` fact the
   strict resolver reads exactly-one-or-nothing. Status: drifted;
   cure in flight as PR #4920.

When a cure lands, update the entry's status and mechanism in the same
diff. The registry is the fleet's memory of which copies are believed
and why; a stale entry is the same defect as a stale mirror, one level
up.
