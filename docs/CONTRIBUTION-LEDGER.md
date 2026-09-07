# Contribution ledger

Proposed contract, 2026-09-07. Docs only. This document does not change Phase 0, merge [PR #8](https://github.com/Uuriko/project-room/pull/8) or [PR #9](https://github.com/Uuriko/project-room/pull/9), or add a payout path.

A Room already records who accepted work, who produced a result, who verified it, and who decided. The ledger makes those acts **visible share weights** so later credit (and, only with an owner go, proceeds) can go to the people and agents who actually contributed.

The spark is [Schroeder's group-project credit note](https://x.com/jpschroeder/status/2096703320618361059): track who did the work, then split later value by that record. Steal that idea only. Ignore any video-game, Steam, marketplace, or token-product frame.

## Product rule

Fold into the existing [Room / Member / Work Item / Artifact / Event](./SPEC-v0.md) model. Do not fork a second product, a second task object, or a credits wallet inside Room.

| Already exists | Ledger use |
| --- | --- |
| Member | The credited party. Humans and agents are both Members. An agent still has an accountable human. |
| Work Item | Optional scope. Room-level coordination may omit `work_item_id`. |
| Artifact | Preferred `evidence_ref` when the act produced or checked a versioned result. |
| Event | The append-only row. Contribution is an Event kind, not a parallel store. |
| Attribution gap | Reporter and producer stay distinct. Unknown producer is a visible gap, not a guessed mint. |
| [Compute Receipt](./BRIDGE-COMPUTE.md) | A later `compute_job` mint may cite the Receipt Event. Compute still owns settle. Room does not become a marketplace. |

v0 of this ledger is **visible share weights only**. No auto-payout, no wallet debit, no invented cents.

## Contribution Event

Append-only. One Event, one credited Member, one act. Correction is a new Event that points at the old one with `superseded_by`. Replay rebuilds the rollup; it never re-mints and never pays.

Proposed type name for the Phase 0.5 schema: `contribution.recorded`. Envelope fields stay the existing Event contract (`id`, `roomId`, `actorId`, `at`, causation / source references). The payload below is the ledger-specific data.

| Field | Required | Meaning |
| --- | --- | --- |
| `room_id` | yes | Room that owns the row. Must match the Event envelope. |
| `work_item_id` | no | Work Item this act served. Omit for Room-level coordination that is not yet a task. |
| `member_id` | yes | Credited Member. Must already belong to the Room. |
| `kind` | yes | One of `commit`, `review`, `verify`, `decide`, `coordinate`, `compute_job`, `artifact`, `other`. |
| `weight` | yes | Positive share weight for this act. v0 displays it; it is not money. |
| `evidence_ref` | yes | Exact source: Artifact URL + version, Event id, commit SHA, or Compute job / Receipt id. |
| `reported_by` | yes | Authenticated Member who recorded the row. Same rule as completion: reporter is the envelope actor. |
| `created_at` | yes | Event time. |
| `superseded_by` | no | Id of the later Contribution Event that replaces this row. Set only by that later Event. |

`reported_by` may differ from `member_id`. That is allowed when an accountable member records someone else's already-existing result, matching the [producer / reporter split](./EVENT-FIXTURES.md#work-state-and-authority). It is not allowed as a way to mint the reporter as the producer without evidence.

Suggested Event type on the Phase 0 event vocabulary: `contribution.recorded`. Do not add a second Outcome table or a signed-token system for v0.

### Kinds

| Kind | Typical evidence | Who may report in v0 |
| --- | --- | --- |
| `commit` | Exact commit SHA / Artifact version the Member produced. | Accountable member, or a later auto-mint from `work.completed` when producer is known. |
| `review` | Review comment or check that is not the designated independent verify. | Reviewing Member. |
| `verify` | Designated `verification.recorded` PASS or FAIL on that exact version. | Designated verifier only. |
| `decide` | Designated `owner.decision_recorded` on that exact version. | Designated human decision-maker only. |
| `coordinate` | Assignment, handoff, or unblock that is not itself the result. | Member with assignment capability. |
| `compute_job` | Compute Receipt Event / job id from the [bridge](./BRIDGE-COMPUTE.md). | Accountable member after a real Receipt. Honesty fields stay on the Receipt. |
| `artifact` | Versioned Artifact that is not a git commit (brief, fixture pack, recording). | Accountable member; producer recorded when known. |
| `other` | Explicit reason in evidence. | Use sparingly. Do not hide a missing kind here. |

Weights are Room-visible numbers, not percentages that must sum to 100. A rollup may show `member_share = member_weight / active_weight` for a Room or Work Item. Superseded rows drop out of the active sum and remain in history.

## Fold, do not fork

Contribution does not change work states. `proposed` / `accepted` / `working` / `blocked` / `completed` / `superseded` stay the Work Item vocabulary. A mint is evidence about an act, like a check or a decision.

| Existing fact | Ledger consequence |
| --- | --- |
| Completion with known `producerId` | May later auto-mint `commit` or `artifact` for that producer, not for the reporter. |
| Completion with unknown producer | No producer mint. Show the attribution gap. The reporter may receive `coordinate` if they honestly reported the find. |
| Independent PASS / FAIL | May later auto-mint `verify` for the designated verifier on that exact version. |
| Owner decision | May later auto-mint `decide` for the designated human on that exact version. |
| Work Item superseded | Active contribution rows on the old item remain historical. They do not move onto the replacement unless a new Event says so. |
| Duplicate Event id / same source + payload | One logical row, same as every other Event. Conflicting reuse is rejected. |
| Compute Receipt | Optional later `compute_job` mint. Room copies honesty; it does not re-measure or settle. |

Agents are first-class Members. The dogfood swarm (Potter, Instinct, Codex, and other invited agents) earns the same visible weights as humans when they actually produce, verify, decide, or coordinate. Display labels such as `[Instinct]` are still not authentication.

## What v0 shows

A member who opens the Room or a return brief should be able to answer: who has recorded contribution here, on which Work Item, with what weight, and from which evidence?

Quiet Focus and the return brief already answer outcome, responsible member, evidence, and next action. The Contributors rollup is an extra panel on that same surface, not a new home screen.

| Surface | Rollup |
| --- | --- |
| Work card | Active weights for that Work Item, each line opening its Event / Artifact. |
| Return brief / Quiet Focus | Room-level active weights since the member last visited, plus any attribution gaps that block a mint. |
| History | Superseded rows stay visible as history. They do not change the current share. |

People should not need ledger vocabulary to talk. Ordinary messages still do not mint.

## Phases

| Phase | Ships | Does not ship |
| --- | --- | --- |
| **Docs (now)** | This contract, README pointer, fixture stubs. | Schema, UI, payout, Phase 0 merge. |
| **0.5** | `contribution.recorded` schema on the existing Event log; rollup projection; negative-path fixtures; Contributors panel drafted off the Phase 0 tip. | Auto-mint, proceeds, merge of #8/#9 as-is. |
| **1** | Auto-mint from completion / verify / decide when producer, verifier, and decision-maker are known and the exact version matches. | Wallet, cents, Compute payout, any transfer. |
| **1b** | Proceeds split using the active rollup. | Nothing until Potter's explicit go. Room still does not collect wallet secrets. Pay stays on its existing door. |

Phase 0 stays the v0 review / Quiet Focus / return-brief slice. Ledger implementation drafts off that tip. It does not absorb Arcade, Multichain, the getdasha Worker, or Compute Start.

## Negative paths (schema work)

These are specified failures, not passing software tests. Instinct owns the Event schema and fixtures on the harness / Phase 0 lane. See the [stub cases](./EVENT-FIXTURES.md#contribution-event-stubs).

| Case | Required result |
| --- | --- |
| Double-mint | Same Room, Member, kind, weight, and `evidence_ref` (or same Event id / idempotency key) returns the existing row. A conflicting payload for that identity is rejected. The rollup counts the act once. |
| `reported_by` ≠ producer claim | A reporter may record another Member's act when evidence names that Member. A reporter may not mint themselves as `commit` / `artifact` producer when the Artifact marks the producer unknown or names someone else. |
| Superseded | The new Event sets `superseded_by` on the old row. Active weight uses only the replacement. History keeps both. A superseded Work Item cannot donate its old rows to a new item without a new Event. |
| Unknown member or wrong Room | Reject. No mint. |
| Verify / decide by the wrong Member | Reject. Designated verifier and human decision-maker rules still apply. |
| Compute mint without a Receipt | Reject. Do not invent tok/s, class, or cents to justify `compute_job`. |

## Non-goals

- No Steam-like store, achievement skin, or game loop.
- No second credits ledger, token mint, or marketplace inside Room. Compute Pay / Credits stay on Compute.
- No auto-payout in docs or 0.5. Phase 1b waits for Potter.
- No merge of Phase 0 PRs #8 or #9 as the delivery vehicle for this work.
- No Potter wallet secrets, seed phrases, or operator keys.
- No `/room` product page from this document.

## Ask

- **Instinct** (Phase 0 / harness owner): Event schema for `contribution.recorded` plus executable negative-path fixtures for double-mint, reporter ≠ producer, and superseded. Draft off the Phase 0 tip; do not merge #8/#9 as-is for this.
- **Codex**: Quiet Focus / return-brief Contributors rollup UI against that schema. Same rule: draft off the Phase 0 tip; do not merge #8/#9 as-is for this.
