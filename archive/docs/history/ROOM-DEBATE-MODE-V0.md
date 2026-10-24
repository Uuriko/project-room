# ROOM-DEBATE-MODE-V0 — Proposer vs challenger

17 September 2026. Contract. Docs only. Not a live API.

Crossfire-shaped ritual: a **proposer** and a **challenger**
(optional **judge**) argue a product bet or architecture choice. The
output is an **action-plan receipt**, not a chat vibe. The verdict
may become an accepted path on the [Ledger Plan Tree](ROOM-PLAN-TREE-V0.md).

**Product personal agent is Second.** Never Genie in product copy,
onboarding, or marketing examples.

Research:
[NOVEL-PLANNING-THINKING-BUILDS-2026-09-17.md](../research/NOVEL-PLANNING-THINKING-BUILDS-2026-09-17.md)
(Crossfire · Corvus · DecisionCanvas · Linear Agent composer).
Architecture SoR:
[ROOM-COHESIVE-ARCHITECTURE.md](ROOM-COHESIVE-ARCHITECTURE.md).
Receipts: [ROOM-RECEIPT-V1.md](ROOM-RECEIPT-V1.md). Graph:
[ROOM-RECEIPT-GRAPH-V0.md](ROOM-RECEIPT-GRAPH-V0.md). Second:
[ROOM-SECOND-V0.md](ROOM-SECOND-V0.md).

## Why

Same-weights personas (three Claudes with different hats) share
blind spots. Crossfire’s kernel is **cross-vendor clash** — Claude /
Codex / Gemini as proposer, challenger, judge — then a synthesized,
prioritized action plan.

Room already has `review` and `scorer` personas. Those grade **Done
receipts**. They do not replace a structured bet *before* the tree
forks. Debate Mode is the Ask ritual for:

- Product bets (ship / don’t / postpone; which surface)
- Architecture choices (soR boundary, harness, data plane)

It is not for leaf implementation and not a standing argument club.

This is not People-rail chrome, not a TUI, and not a live writer.

## When to use

| Use Debate Mode | Do not |
| --- | --- |
| Two or more live paths, only one should become the accepted plan | A single accepted leaf that just needs implement |
| Architecture that would be expensive to reverse | Style nits, copy edits, kit recommend (use Jev) |
| Product bet that binds a Mission Envelope | Routine triage / clarify |
| Cross-vendor disagreement would change the tree | Same-model “red team” as theater |

Default is **off**. A human (owner or steward) opens a debate on a
Work Item or a plan-tree `goal` node. Second may *propose* opening
one; it does not self-start a clash that spends specialist turns.

## Roles

| Role | Who | Job |
| --- | --- | --- |
| **Proposer** | Seat or specialist harness (Claude, Codex, Gemini, …) | State the bet. Name assumptions, sources, reversibility. |
| **Challenger** | A **different** provider / harness when possible | Attack assumptions. Cite counter-sources. Name what would change the mind. |
| **Judge** (optional) | Third harness **or** a human | Synthesize. Produce the action plan. Does not rewrite proposer/challenger text. |
| **Steward** | Human | Opens, stops, accepts or rejects the action plan. Required. |

Same-weights fallback (two `room` seats, one model) is allowed when
only one harness is enrolled. Label it `diversity: framing` — not
`diversity: thought`. Honesty over theater.

**Second** may be steward-side: open, messenger, summarize. Second is
not the default proposer *and* challenger. Loyalty means it does not
sandbag the owner’s stated bet; it also does not hide the challenger’s
case ([ROOM-SECOND-V0.md](ROOM-SECOND-V0.md) §4).

## Shape (Crossfire)

Steal the *shape*, not the TUI or skip-permissions adapters.

```
open → proposer turn → challenger turn → (repeat ≤ N) → judge|steward synthesize
                                                         → action-plan receipt
                                                         → human accept|reject
```

| Crossfire kernel | Room mapping |
| --- | --- |
| Proposer vs challenger, optional judge | Roles above; member ids, not display names |
| Multi-provider adapters | Connect harness honesty: provider · model · harness (inert+reason) |
| Convergence / round cap | `maxRounds` + `stopOn`. No unbounded clash |
| Markdown / HTML action plan | `room.receipt.v1` artifact `type: file` + `plan` honesty block |
| Transcript + event store | Receipt graph. Each turn cites the prior turn’s receipt |
| Coalition map | Optional `alignment[]` on the verdict — member ids + `agree\|dissent\|abstain` |

Do not copy `--dangerously-skip-permissions`, `--yolo`, or
`--full-auto` as Room defaults. Ask every time + Cua dual boundary
still hold.

## Object

```json
{
  "kind": "room.debate.v0",
  "id": "string",
  "workItemId": "string",
  "nodeId": "string|null",
  "topic": "string",
  "betType": "product|architecture",
  "status": "open|converged|stopped|accepted|rejected",
  "maxRounds": 3,
  "stopOn": "convergence|max-rounds|steward-stop",
  "diversity": "thought|framing",
  "roles": {
    "proposer": { "memberId": "string", "harness": "string|null", "model": "string|null" },
    "challenger": { "memberId": "string", "harness": "string|null", "model": "string|null" },
    "judge": { "memberId": "string|null", "harness": "string|null", "model": "string|null" },
    "steward": { "memberId": "string" }
  },
  "rounds": [],
  "verdictReceiptId": "string|null",
  "actionPlanNodeId": "string|null"
}
```

| Field | Rule |
| --- | --- |
| `nodeId` | Plan-tree node this bet hangs on, or `null` for a Work Item-level bet. |
| `betType` | `product` or `architecture`. Other work uses review / scorer. |
| `maxRounds` | Default `3`. Hard cap. Steward may stop earlier. |
| `diversity` | `thought` when proposer and challenger use different providers. `framing` when they do not. Do not claim thought-diversity you did not have. |
| `judge.memberId` | Optional. Absent judge → steward synthesizes. A seat may not be proposer and judge. |
| `verdictReceiptId` | The action-plan `room.receipt.v1`. `null` until synthesize. |
| `actionPlanNodeId` | Plan-tree node created or updated from an **accepted** verdict. `null` until `debate.accept`. |

`harness` / `model` are honesty fields. Unknown stays `null`. Never
rename a model to hide a limit
([ROOM-KITS-HARNESS-JEV-ROY.md](ROOM-KITS-HARNESS-JEV-ROY.md)).

## Turn

```json
{
  "round": 1,
  "role": "proposer|challenger|judge",
  "receiptId": "string",
  "cites": ["string"]
}
```

Each turn **is** a receipt. `cites` must include the immediately prior
turn when one exists. Missing cite = orphan claim.

## Action-plan receipt

The point of the ritual. Not a winner badge.

```json
{
  "kind": "room.receipt.v1",
  "id": "string",
  "workItemId": "string",
  "persona": "review",
  "agentMemberId": "string",
  "completedAt": "ISO-8601",
  "traceRef": "string|null",
  "artifacts": [
    {
      "type": "file",
      "path": "debate/action-plan.md",
      "url": null,
      "cmd": null,
      "sha256": "string|null",
      "peopleData": false
    }
  ],
  "citedReceiptIds": ["string"],
  "debate": {
    "act": "verdict",
    "debateId": "string",
    "betType": "product|architecture",
    "decision": "path-a|path-b|hybrid|postpone|reject-bet",
    "priorities": ["string"],
    "alignment": [
      { "memberId": "string", "stance": "agree|dissent|abstain" }
    ]
  }
}
```

| Field | Rule |
| --- | --- |
| `persona` | `review` for a seat judge; human steward still records a receipt with their `agentMemberId` unused — use the steward’s member id on `principalId` / Trust Handoff. |
| `citedReceiptIds` | All turn receipts this verdict relied on. Empty is dishonest after a clash. |
| `debate.decision` | Named path, hybrid, postpone, or reject the bet. Not a 1–10 score. |
| `priorities` | Ordered next actions. These become proposed plan-tree children **only after** `debate.accept`. |
| `alignment` | Optional coalition map. Member ids only. |

Artifact path is a convention, not a live writer. `peopleData` stays
`false`. No faces, PII, private inbox.

## Receipts

| Kind | When |
| --- | --- |
| `debate.open` | Steward opens. Names roles, `betType`, `maxRounds`. |
| `debate.turn` | Proposer, challenger, or judge turn. Cites prior turn. |
| `debate.verdict` | Action-plan receipt (`debate.act = verdict`). |
| `debate.accept` | Human accepts the action plan. May emit `plan.propose` children + `plan.accept` on the chosen path. |
| `debate.reject` | Human rejects. Tree unchanged. Reason in artifacts / `traceRef`. |
| `debate.stop` | Steward stop before max rounds. Still needs a verdict or an honest `stopped` with no plan. |

`debate.accept` is Ask. A judge verdict is **not** accept. DecisionCanvas
lesson: agent-built plans start Draft / `proposed`. Official (accepted
path on the tree) is a human Act.

Corvus lesson: rejecting or replacing an accepted path **appends**
`plan.supersede` + a new debate or revise. Do not silently edit the
old verdict.

## Lifecycle

```
steward opens
    → proposer (receipt)
    → challenger (cites proposer)
    → … ≤ maxRounds or convergence or stop
    → judge or steward verdict (action-plan receipt)
    → steward accept | reject
         accept → proposed (then accepted) path on the plan tree
         reject → tree unchanged
```

Convergence means the challenger has no new material claim — labeled
on the turn, not inferred from vibes. Steward may still reject a
converged plan.

## Rules

1. **Cross-vendor when you claim thought-diversity.** Otherwise
   `diversity: framing`.
2. **Cite every hop.** Turn N cites turn N−1. Verdict cites the turns
   it used. Orphan claims fail the scorer.
3. **Ask is accept.** Judge ≠ steward. Second ≠ auto-accept.
4. **No implement from a live debate.** Implementation / Compute / Cua
   wait for `debate.accept` **and** the plan-tree accepted-leaf +
   design-bound gate ([ROOM-PLAN-TREE-V0.md](ROOM-PLAN-TREE-V0.md)).
5. **Reversibility honesty.** If the bet is irreversible, Trust
   Handoff needs `ask-before-irreversible` before accept
   ([ROOM-TRUST-HANDOFF-V0.md](ROOM-TRUST-HANDOFF-V0.md)).
6. **People-data ban.** Transcripts, priorities, alignment: member ids
   and paths only.
7. **Compute is not the debate.** Turns may *use* a specialist
   harness. The clash lives on the Work Item. A Compute job id is not
   a verdict.
8. **Scorers append only.** They may grade procedure (right roles,
   cites present) or orphan-claim. They do not pick the product.

## MCP read (Second / Claude / Codex)

| Tool (shape) | Who | Does |
| --- | --- | --- |
| `debate.get` | Second, Claude, Codex, enrolled seats | Debate object + turn receipt ids |
| `debate.transcript` | same | Ordered turn artifacts (no people-data) |
| `debate.turn` | Role-bound seat / harness | Append a turn receipt. Cannot accept. |

Accept / reject / open / stop stay human Acts (or a granted steward).
Inert + reason when Debate Mode is off for that Work Item.

## Pair with

- [ROOM-PLAN-TREE-V0.md](ROOM-PLAN-TREE-V0.md) — accepted verdict
  becomes a path under `nodeId`.
- [ROOM-SCORER.md](ROOM-SCORER.md) — procedure-compliance may fail a
  same-weights clash labeled `thought`.
- [ROOM-PERSONAS-FACTORY.md](ROOM-PERSONAS-FACTORY.md) — roles are not
  a new member table. They are claim types for the ritual.
- [ROOM-KITS-HARNESS-JEV-ROY.md](ROOM-KITS-HARNESS-JEV-ROY.md) — Jev
  may recommend harnesses for proposer / challenger. Recommend ≠
  appoint.

## Stay-outs

`client/` · `cloudflare/` · `server/` · `src/` · `deploy/` · Connect
door HTML · People rail · Done-chip chrome · Muse debate UI / TUI ·
Phase 0 #8 / #9 · Quill trees · Compute Start · people-data ·
Potter keys · live writer · skip-permissions adapters · auto-accept ·
calling Second a Genie.
