# ROOM-PLAN-TREE-V0 — Ledger Plan Tree

17 September 2026. Contract. Docs only. Not a live API.

The Mission Envelope is a **governed plan tree**. Agents propose
subtrees. Humans accept. Design-bound implement may claim only
**accepted leaves**. Every node change emits a `room.receipt.v1`.
The tree is MCP-readable for **Second**, Claude, and Codex.

**Product personal agent is Second.** Never Genie in product copy,
onboarding, or marketing examples.

Research:
[NOVEL-PLANNING-THINKING-BUILDS-2026-09-17.md](../research/NOVEL-PLANNING-THINKING-BUILDS-2026-09-17.md)
(TSP · cuddlytoddly · Corvus · DecisionCanvas · Memorable).
Architecture SoR:
[ROOM-COHESIVE-ARCHITECTURE.md](ROOM-COHESIVE-ARCHITECTURE.md).
Receipts: [ROOM-RECEIPT-V1.md](ROOM-RECEIPT-V1.md). Graph:
[ROOM-RECEIPT-GRAPH-V0.md](ROOM-RECEIPT-GRAPH-V0.md). Maturity:
[ROOM-ARTIFACT-MATURITY.md](ROOM-ARTIFACT-MATURITY.md). Debate
(optional parent ritual): [ROOM-DEBATE-MODE-V0.md](ROOM-DEBATE-MODE-V0.md).
Second: [ROOM-SECOND-V0.md](ROOM-SECOND-V0.md).

## Why

A Work Item already carries personas, artifacts, a receipt graph, and
a maturity rung. That is not enough when the *plan* still lives in a
chat scroll. TSP moves the plan onto a canvas where every branch is a
workspace that still sees the whole. cuddlytoddly builds an editable
DAG **before any tool**. Room folds both into the ledger:

- The tree *is* the Mission Envelope’s plan face.
- Second / Claude / Codex read the same nodes over MCP.
- Accept is Ask. Unaccepted nodes are not executable.
- Implementation cannot claim until the leaf is accepted **and** the
  design-bound gate passes (HumanLayer RPI-lite).

This is not People-rail chrome, not a Muse canvas, and not a live
writer.

## Shape (TSP canvas + cuddlytoddly DAG)

Steal the *shape*, not the product.

| Source | Kernel | Room mapping |
| --- | --- | --- |
| TSP | Agents propose a subtree; you accept or reject; MCP peers share one record | `plan.propose` / `plan.accept` / `plan.reject` receipts |
| TSP | Connected agents write branch, files, handoff notes | Receipt + `citedReceiptIds[]`; no silent chat claim |
| cuddlytoddly | Goal → clarification → DAG of tasks + deps **before tools** | Clarification node is first. No Compute / Cua / implement until accept |
| cuddlytoddly | Pause, edit deps, promote to subgoal; only children re-run | `plan.revise` resets descendants; completed leaves stay |
| Corvus | Append a new decision that cites the old one | Supersede = new node + cite, not an in-place edit |
| DecisionCanvas | Agent output starts Draft; only Official is AI-citable | New nodes are `proposed`. Cite gate follows maturity |
| Memorable | Decision / Observation / Task stapled to entities | Optional `memoryRefs[]` on a node. Forget is an Act |

Canvas chrome (zoom, districts, ghost nodes) is a later Muse face.
v0 is the **object + receipts + MCP read**.

## Object model

The tree hangs on one Work Item / Mission Envelope.

```
Work Item
  planTree
    rootId
    nodes[]          # goal | task | dep | clarification
    edges[]          # parent / depends_on / supersedes
  personas[]
  artifacts[]
  receipt_graph
  maturity
  scores[]
```

### Node

```json
{
  "kind": "room.plantree.node.v0",
  "id": "string",
  "workItemId": "string",
  "type": "goal|task|dep|clarification",
  "title": "string",
  "intent": "string|null",
  "scope": "string|null",
  "status": "proposed|accepted|rejected|superseded|blocked|done",
  "parentId": "string|null",
  "dependsOn": ["string"],
  "acceptance": {
    "acceptedBy": "string|null",
    "acceptedAt": "ISO-8601|null",
    "waiveReceiptId": "string|null"
  },
  "maturity": "live-note|discussion-paper|synthesis-memo|workshop-paper|working-paper",
  "proposedBy": "string",
  "assigneeMemberId": "string|null",
  "leaf": true,
  "memoryRefs": [],
  "citedReceiptIds": []
}
```

| Field | Rule |
| --- | --- |
| `id` | Stable node id. Required to be citable. No display name, email, or account id. |
| `type` | `goal` (intent), `task` (doable unit), `dep` (declared dependency edge made a node when it carries notes), `clarification` (unknowns that would change the DAG). |
| `status` | `proposed` until a human accept / reject. Agents do not self-accept. |
| `dependsOn` | Node ids that must be `accepted` (and `done` when the edge is a hard finish-to-start) before this leaf may run. DAG, not a mash. No self-dep. |
| `acceptance.acceptedBy` | Room member id of the human who accepted. `null` while proposed. |
| `waiveReceiptId` | Owner waive of design-bound implement, when used. Cite, don’t invent. |
| `maturity` | Defaults to **Live Note**. Session `done` does not promote. |
| `proposedBy` | Member id of the proposing seat (Second, `room` seat, or human). |
| `leaf` | `true` when the node has no accepted children. Implement claims only accepted leaves. |
| `memoryRefs` | Memorable-shaped `{ type: decision\|observation\|task, ref }` staples. Empty is honest. |
| `citedReceiptIds` | Prior receipts this node relied on (proposal rationale, debate verdict, superseded node). |

### Edge

```json
{
  "from": "string",
  "to": "string",
  "rel": "parent|depends_on|supersedes"
}
```

| `rel` | Meaning |
| --- | --- |
| `parent` | Decomposition. Child is a subtree of `from`. |
| `depends_on` | Ordering. `to` waits on `from`. |
| `supersedes` | Corvus append. `from` is the new decision; `to` becomes `superseded`. |

Cycles are not a tree. A cyclic propose fails closed (`plan.invalid`).

## Lifecycle

```
clarification → proposed subtree → human accept|reject
      ↑                                    │
      └── plan.revise (children reset)     ▼
                                   accepted leaf
                                           │
                    design ≥ Discussion Paper
                    or owner waive receipt
                                           │
                                           ▼
                         implement / Compute / Cua may claim
                                           │
                                           ▼
                                      done + receipt
```

### Rules

1. **Propose, don’t grow.** Second, Claude, Codex, or a `room` seat may
   attach a proposed subtree. They may not flip `status` to `accepted`.
2. **Ask is accept.** A human (owner or granted steward) accepts or
   rejects. Silence is not accept. Smart Routing may wake Second to
   *explain* a proposal; it does not auto-accept.
3. **No tools on unaccepted nodes.** No implement claim, no Compute
   job, no Cua Fleet claim, no specialist harness lease for that leaf.
4. **Design-bound implement.** An accepted leaf is still blocked until
   the design artifact is ≥ Discussion Paper **or** an owner waive
   receipt is cited ([ROOM-COHESIVE-ARCHITECTURE.md](ROOM-COHESIVE-ARCHITECTURE.md)
   §4.4).
5. **Leaves only.** Implementation persona claims accepted leaves, not
   parent goals. Promoting a task to a subgoal (`plan.revise`) makes
   the old leaf a parent; children start `proposed`.
6. **Append, don’t rewrite.** Changing intent / scope / deps on an
   accepted node emits `plan.revise` and, when the decision itself
   changed, a `supersedes` edge to the old node. In-place mutation of
   accepted intent is not a graph.
7. **Clarification first.** cuddlytoddly-shaped: extract stated facts,
   mark genuine unknowns. Do not ask humans for data a tool can fetch.
8. **Official-only cite for grounding.** Second / synthesis may treat
   a node as citable context when its maturity is Workshop Paper /
   Working Paper, or when a waive receipt says so. Draft / proposed /
   unknown fails closed (DecisionCanvas lesson).
9. **Same Work Item by default.** Cross-item parent pointers need the
   related Work Item named on the envelope. Silent cross-item deps
   are `plan.invalid`.
10. **People-data ban.** Titles, intent, scope, memory refs: no faces,
    PII, private inbox, emails, account ids, or display names.

## Receipts (every node change)

Chip = face. Receipt = evidence. A node status paint is not enough.

| Kind | When | Must cite |
| --- | --- | --- |
| `plan.propose` | Subtree or node added as `proposed` | Parent node and any debate / memory receipts relied on |
| `plan.accept` | Human accepts one node or an explicit subtree | The `plan.propose` receipt |
| `plan.reject` | Human rejects | The `plan.propose` receipt; reason in `traceRef` / artifacts, not people-data |
| `plan.revise` | Edit intent / deps / promote-to-subgoal | Prior accept (if any) + the nodes reset |
| `plan.supersede` | New decision replaces an accepted node | Superseded node’s last receipt |
| `plan.done` | Accepted leaf closed with artifacts | Accept + design / waive + implement receipts |
| `plan.invalid` | Cycle, silent cross-item dep, self-accept attempt | Offending proposal (scorer may also flag) |

These are `room.receipt.v1` objects with `persona` of the actor
(`foreman` proposes splits; `implementation` may not propose-and-accept
its own leaf). `citedReceiptIds` is required whenever the change relied
on prior agent work. Orphan claims fail
[orphan-claim](examples/scorers/orphan-claim/scorer.md).

Scorers **append** only. They never rewrite the tree.

```json
{
  "kind": "room.receipt.v1",
  "id": "string",
  "workItemId": "string",
  "persona": "foreman|triage|implementation|review|scorer",
  "agentMemberId": "string",
  "completedAt": "ISO-8601",
  "traceRef": "string|null",
  "artifacts": [],
  "citedReceiptIds": ["string"],
  "plan": {
    "act": "propose|accept|reject|revise|supersede|done|invalid",
    "nodeIds": ["string"],
    "parentId": "string|null"
  }
}
```

`plan` is an optional honesty block on `room.receipt.v1` for this
contract. Missing `plan` means the receipt is not a tree mutation.

## MCP read (Second / Claude / Codex)

v0 is **read + propose**. Write of `accepted` is a human Act, not an
MCP tool.

| Tool (shape) | Who | Does |
| --- | --- | --- |
| `plan.tree.get` | Second, Claude, Codex, `room` seats | Return the Work Item tree: nodes, edges, statuses, cited receipt ids |
| `plan.node.get` | same | One node + its receipts |
| `plan.propose` | same, under authority | Attach a proposed subtree. Emits `plan.propose`. Does **not** accept |
| `plan.memory.search` | same | Memorable-shaped recall stapled to node / entity ids |

**Second** is the coordinator: it may propose, explain, and messenger
a subtree to a steward. It does not self-accept. Claude and Codex are
specialist harnesses under Second / Connect — peers on the **record**,
not peer personal agents ([ROOM-SECOND-V0.md](ROOM-SECOND-V0.md) §8).

Pull-mode MCP clients fetch the tree on their schedule. Wake-mode
hosts receive `plan.propose` notices when attention is `all` or they
were mentioned. `@Second` is an interrupt, not required to read the
tree.

Inert + reason when the Work Item has no `planTree` yet — honesty, not
an invented root.

## Design-bound implement (accepted leaves)

Pairs the existing RPI-lite gate:

1. Leaf `status === accepted`.
2. Design artifact ≥ Discussion Paper **or** `waiveReceiptId` present.
3. `dependsOn` nodes are `accepted` (and `done` when the edge says so).
4. Implementation persona claims that leaf only.
5. Done emits `plan.done` citing accept + design/waive + implement
   receipts.

Unaccepted, rejected, superseded, or blocked leaves are not claimable.
A parent `goal` is not a leaf.

## Work Item envelope (additive)

```
Work Item
  planTree { rootId, nodes[], edges[] }
  receipt_graph
  ...
```

The envelope in
[ROOM-COHESIVE-ARCHITECTURE.md](ROOM-COHESIVE-ARCHITECTURE.md) §2.3
gains `planTree`. This contract is the node / edge / receipt rules.
A later Work Item template may render markdown; v0 does not require
chrome.

## Pair with

- [ROOM-DEBATE-MODE-V0.md](ROOM-DEBATE-MODE-V0.md) — product /
  architecture bets may run a debate; the action-plan receipt becomes
  the accepted path under the parent node.
- [ROOM-TRUST-HANDOFF-V0.md](ROOM-TRUST-HANDOFF-V0.md) — proposing is
  not authority to implement.
- [ROOM-KITS-HARNESS-JEV-ROY.md](ROOM-KITS-HARNESS-JEV-ROY.md) — Jev
  recommends which kit runs an **accepted** leaf. Recommend ≠ accept.
- [BRIDGE-COMPUTE.md](BRIDGE-COMPUTE.md) — Compute job ids correlate
  to accepted leaves. A Compute job is not a plan node.

## Stay-outs

`client/` · `cloudflare/` · `server/` · `src/` · `deploy/` · Connect
door HTML · People rail · Done-chip chrome · Muse canvas / ghost-node
UI · Phase 0 #8 / #9 · Quill trees · Compute Start · people-data ·
Potter keys · live writer · auto-accept · `--dangerously-skip-permissions`
· calling Second a Genie.
