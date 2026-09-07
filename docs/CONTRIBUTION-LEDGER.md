# Contribution ledger

Proposed contract, 2026-09-07. The Phase 0.5 derived rollup lives in [`contribution-rollup/`](../contribution-rollup/). This document does not change Phase 0, merge [PR #8](https://github.com/Uuriko/project-room/pull/8) or [PR #9](https://github.com/Uuriko/project-room/pull/9), or add a payout path.

A Room already records who proposed work, who produced a result, who verified it, and who decided. The ledger is a **read-model** over those facts so later credit (and, only with an owner go, proceeds) can go to the people and agents who actually contributed.

The spark is [Schroeder's group-project credit note](https://x.com/jpschroeder/status/2096703320618361059): track who did the work, then split later value by that record. Steal that idea only. Ignore any video-game, Steam, marketplace, or token-product frame.

Design discussion lives on the [Project Room coordination mailbox](https://github.com/Uuriko/project-room/issues/11). Do not merge #8/#9 as the delivery vehicle. Do not touch the identity D235 ship, Arcade, Multichain, or the getdasha Worker.

## Product rule

Fold into the existing [Room / Member / Work Item / Artifact / Event](./SPEC-v0.md) model. **Aggregate existing Events and Work Item roles.** Do not invent a disconnected scoreboard, a second task object, or a credits wallet.

| Already exists | Ledger use |
| --- | --- |
| Event envelope `actorId` | Server-set. The only actor the rollup may trust. Client-supplied names and forged actors do not count. |
| Work Item `proposedById` | Role on the item. Optional later on work cards. Not a v0 weight by itself. |
| Completion receipt `producerId` / `reportedById` | Producer is credited for `complete` / `artifact` when known. Reporter is not the producer. |
| Verification `verifierId` | Credited for `verify` on that exact version. |
| Decision actor | Credited for `decide` on that exact version. |
| Artifact | Preferred evidence pointer: URL + version, or commit SHA. |
| Attribution gap | Unknown producer is a visible gap, not a guessed share. |
| [Compute Receipt](./BRIDGE-COMPUTE.md) | Honesty stays on the Receipt. Not a v0 weight kind. |

v0 of this ledger is **visible share weights only**. No auto-payout, no wallet debit, no invented cents.

The [v0 spec](./SPEC-v0.md) and [first workflow](./FIRST-WORKFLOW.md) already reject “more activity = more value.” Message volume and acknowledgment counts are not success measures. Weights attach only to evidence-backed kinds below. Ordinary `message.posted` rows never mint a share.

## Derived row (read-model)

Do not add a write-side `contribution.recorded` Event for the first cut. Replay existing Events and project one row per credited act. A later explicit Contribution Event is allowed only if derivation cannot express a correction; it is not the default store.

| Projected field | Source |
| --- | --- |
| `room_id` | Event `roomId`. |
| `work_item_id` | Work Item on the source Event. Omit only if the source Event has none. |
| `member_id` | Role on that fact: known `producerId`, designated `verifierId`, or decision actor. Never a guessed reporter. |
| `kind` | One of `complete`, `verify`, `decide`, `artifact`. |
| `weight` | Positive share for that evidence-backed act. v0 displays it; it is not money. |
| `evidence_ref` | Exact Artifact version, completion Event id, verification Event id, or decision Event id. |
| `reported_by` | Envelope `actorId` of the source Event (server-set). |
| `created_at` | Source Event `at`. |
| `superseded_by` | Set when the Work Item or that exact result version is superseded. Active rollup drops the old row. |

`reported_by` may differ from `member_id`. That is the existing [producer / reporter split](./EVENT-FIXTURES.md#work-state-and-authority). A reporter who finds someone else's result does not become the producer.

### Kinds that may carry weight

| Kind | Derived from | Credited member |
| --- | --- | --- |
| `complete` | `work.completed` with known `producerId` and a versioned Artifact. | `producerId`. |
| `verify` | `verification.recorded` on that exact completion / version. | Designated `verifierId`. |
| `decide` | `owner.decision_recorded` on that exact completion / version. | Designated human decision-maker. |
| `artifact` | Versioned Artifact that is the result (commit SHA or other exact version). | Known producer. Same attribution-gap rule as `complete`. |

No other kind carries v0 weight. Not messages. Not acknowledgments. Not `review`, `coordinate`, `other`, or `compute_job` chatter. A later phase may add evidence-backed kinds; it may not count activity.

Weights are Room-visible numbers, not percentages that must sum to 100. A rollup may show `member_share = member_weight / active_weight` for a Room or Work Item. Superseded rows drop out of the active sum and remain in the event list.

## Fold, do not fork

Contribution does not change work states. `proposed` / `accepted` / `working` / `blocked` / `completed` / `superseded` stay the Work Item vocabulary. The rollup is a view of existing checks and decisions.

| Existing fact | Rollup consequence |
| --- | --- |
| Completion with known `producerId` | One `complete` (and `artifact` if that version is the result) for the producer. |
| Completion with unknown producer | No producer share. Show the attribution gap. Do not credit `reportedById` as producer. |
| Independent PASS / FAIL | One `verify` for the designated verifier on that exact version. |
| Owner decision | One `decide` for the designated human on that exact version. |
| `proposedById` | Identity on the Work Item. Not a v0 weight. Optional later on the work card. |
| Work Item or result superseded | Old derived rows become historical. They do not move onto the replacement unless a new evidence-backed Event says so. |
| Duplicate Event id / same source + payload | One logical source Event, so one derived row. |
| Forged or client-supplied actor | Ignore. Only server-set `actorId` and stored roles count. |

Agents are first-class Members. The dogfood swarm earns the same visible weights as humans when they produce, verify, or decide. Display labels such as `[Instinct]` are still not authentication.

## What v0 shows

A member who opens a return brief should see who contributed, from which Event, with what weight — without a new home screen or ledger vocabulary.

| Surface | When |
| --- | --- |
| Return brief / Quiet Focus | First. Contributors is a **read-model**: active weights since last visit, each line opening the source Event / Artifact, plus attribution gaps. |
| Event list | First, with the brief. Same derived rows as ordinary history. No separate scoreboard. |
| Work card `proposedById` | Optional, later. Proposer identity only; not a weight. |
| History | Superseded rows stay visible as history. They do not change the current share. |

People should be able to discuss a result without learning ledger terminology. Ordinary messages still do not mint.

## Phases

| Phase | Ships | Does not ship |
| --- | --- | --- |
| **Docs (now)** | This contract, README pointer, fixture stubs. Coordination on [#11](https://github.com/Uuriko/project-room/issues/11). | Schema writes, UI, payout, Phase 0 merge. |
| **0.5** | Derived rollup from completion / verify / decide / artifact; negative-path fixtures; Quiet Focus / return-brief Contributors **read-model only**, drafted off the Phase 0 tip. The isolated module lives in [`contribution-rollup/`](../contribution-rollup/) and does not merge [PR #8](https://github.com/Uuriko/project-room/pull/8) or [PR #9](https://github.com/Uuriko/project-room/pull/9). | New scoreboard Event as the store. Auto-payout. Merge of #8/#9 as-is. Identity D235, Arcade, Multichain, Worker. |
| **1** | Live derivation in the product (still a projection, not a second ledger). | Wallet, cents, Compute payout, any transfer. |
| **1b** | Proceeds split using the active rollup. | Nothing until Potter's explicit go. Room still does not collect wallet secrets. Pay stays on its existing door. |

Phase 0 stays the v0 review / Quiet Focus / return-brief slice. Ledger work drafts off that tip and reports on [#11](https://github.com/Uuriko/project-room/issues/11).

## Negative paths (fixture work)

Executable fixtures live in [`contribution-rollup/fixtures/`](../contribution-rollup/fixtures/). They **derive** the rollup from completion / verify / decide. See the [C1–C4 cases](./EVENT-FIXTURES.md#contribution-event-stubs).

| Case | Required result |
| --- | --- |
| Double-count | Replaying the same completion, verification, or decision (same Event id or same source + payload) yields one derived row. The rollup does not add the weight twice. |
| Forged actor | A client-supplied actor, display label, or message prefix does not create a share. Only server-set `actorId` and stored Work Item roles count. |
| Unknown producer | Completion with omitted / unknown `producerId` creates no `complete` or `artifact` share for the reporter or anyone else. The gap stays visible. |
| Verify / decide by the wrong Member | No `verify` or `decide` share. Designated verifier and human decision-maker rules still apply. |
| Message / ack activity | Zero weight. |

## Non-goals

- No disconnected scoreboard or write-side token mint as the source of truth.
- No Steam-like store, achievement skin, or game loop.
- No second credits ledger or marketplace inside Room. Compute Pay / Credits stay on Compute.
- No auto-payout in docs or 0.5. Phase 1b waits for Potter.
- No merge of Phase 0 PRs #8 or #9 as the delivery vehicle.
- No edits to the identity D235 ship, Arcade, Multichain, or the getdasha Worker.
- No Potter wallet secrets, seed phrases, or operator keys.
- No `/room` product page from this document.

## Ask

Design replies and fixtures on [#11](https://github.com/Uuriko/project-room/issues/11). Draft off the Phase 0 tip. Do not merge #8/#9 as-is for this.

- **Instinct** (Phase 0 / harness owner): fixtures that derive the Contributors rollup from completion / verify / decide (and artifact when that is the result), plus negatives for **double-count**, **forged actor**, and **unknown producer**. The isolated `contribution-rollup` module is that 0.5 cut.
- **Codex**: Quiet Focus / return-brief Contributors **read-model only**. Import `contributorsForReturnBrief` from `contribution-rollup`. Same source Events. No separate scoreboard UI. Optional `proposedById` on work cards is later, not this slice. Do not merge #8/#9 to wire it.
