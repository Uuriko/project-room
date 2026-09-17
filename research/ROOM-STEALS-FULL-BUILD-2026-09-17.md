# Project Room — finish all steals · full build-out

**2026-09-17 · Potter go · Muse ACK build-out lane**

Docs / research / specs only. This note is the master plan for the steal
contracts. It does not ship a live kit door, a Connect panel, or a
People-rail change.

Pairs with:

- [#454](https://github.com/Uuriko/project-room/pull/454) — Cua desktop
  kit + Fleet spike (docs only)
- [#457](https://github.com/Uuriko/project-room/pull/457) — Warp Scorers
  + Skillbox + harness-bridge research map
- [ROOM-COMPETITIVE-LANDSCAPE-2026-09-17.md](ROOM-COMPETITIVE-LANDSCAPE-2026-09-17.md)
  — cousin landscape (Oasis, agensis, Agent Room, Alook, HumanLayer)
- [ROOM-NOVEL-SYNTHESIS-2026-09-17.md](ROOM-NOVEL-SYNTHESIS-2026-09-17.md)
  — Ledger Room fold (six-axis seat + receipt graph)

No deploy.

## Sources

| # | Source | Core idea |
|---|--------|-----------|
| 1 | [trycua/cua](https://github.com/trycua/cua) | Driver MCP + Fleet claim/release |
| 2 | [Warp Scorers](https://www.warp.dev/blog/using-llm-as-a-judge-scoring-to-measure-your-software-factory) | LLM-judge past runs; sample; self-improve PRs |
| 3 | [Kitze Skillbox](https://github.com/kitze/skillbox) (MIT) | Versioned skills + MCP + Jev router |
| 4 | [0xSero harness-bridge](https://github.com/0xSero/harness-bridge) | Any harness ↔ any compatible endpoint |
| 5 | Roy model rank | Ladder astra > glm > dsv; default = fast dsv |
| 6 | TypeSafe Jev | Typed kit recommend without 30-turn search |
| 7 | [hraness factory](https://x.com/hraness/status/2100358405911105590) | N× parallel agents; model-limit honesty |
| 8 | [Interlateral](https://interlateral.com/) / Stanford FutureLaw report | Trust Handoff, Agent Interaction Receipt, Artifact Maturity Ladder |
| 9 | Cousin landscape (Oasis, agensis, Agent Room, Alook, HumanLayer, Factory.ai, Dust) | Shared-room cousins; steal membership / authority / artifact patterns — see [ROOM-COMPETITIVE-LANDSCAPE-2026-09-17.md](ROOM-COMPETITIVE-LANDSCAPE-2026-09-17.md) |

## Cua files (merged)

`docs/ROOM-CUA-DESKTOP.md` and
`research/CUA-FLEET-SPIKE-2026-09-17.md` landed in
[#454](https://github.com/Uuriko/project-room/pull/454).

Scorers need those Cua / Fleet **Done receipts** (screenshot path +
shell log + later `traceRef`) as judge input. Chip = face; receipt =
evidence. Do not invent Quality / Efficiency / Compliance scores
without a trace. Cua desktop remains an **Optional later** catalog row
— not a live `/room/kits` door.

## Contracts (this PR)

### A. `room.receipt.v1`

Artifacts panel = **Done receipt** (evidence). Done chip = People-rail
face. Scorers judge Done receipts, not chips. Cua fleet fields
optional. `peopleData: false` required on screenshots.

Contract: [ROOM-RECEIPT-V1.md](../docs/ROOM-RECEIPT-V1.md)

This is **not** the GitHub issue-#11 merge receipt in
[examples/receipt.md](../docs/examples/receipt.md). Merge receipts stay
the protocol face for claims-board Done. `room.receipt.v1` is the
judgeable artifact pack for scorers.

### B. Scorer kit / `scorers/<slug>/scorer.md`

One dimension; labels + `passingScore` + `samplingRate` + model;
human-merge self-improve only.

Contract: [ROOM-SCORER.md](../docs/ROOM-SCORER.md)

Default examples:

- [task-compliance](../docs/examples/scorers/task-compliance/scorer.md)
- [efficiency](../docs/examples/scorers/efficiency/scorer.md)
- [procedure-compliance](../docs/examples/scorers/procedure-compliance/scorer.md)
- [people-data-safe](../docs/examples/scorers/people-data-safe/scorer.md)
- [orphan-claim](../docs/examples/scorers/orphan-claim/scorer.md)

### C. Personas

`foreman` | `triage` | `implementation` | `review` | `scorer`

Contract: [ROOM-PERSONAS-FACTORY.md](../docs/ROOM-PERSONAS-FACTORY.md)

### D. Factory parallelism (hraness)

N agent members on distinct Work Items; fail-loud when model / provider
limits hit.

Research: [ROOM-HRANESS-STEAL-2026-09-17.md](ROOM-HRANESS-STEAL-2026-09-17.md)

### E. Kits / harness / Jev / Roy

Skillbox-shaped versioned kits; Connect shape
provider · model · harness (when UI ships: **enrolled-agent config
under Connect**, not a fourth Join path); Jev `recommend_kits`; fast
default + quality ladder honesty.

Contract: [ROOM-KITS-HARNESS-JEV-ROY.md](../docs/ROOM-KITS-HARNESS-JEV-ROY.md)

### F. Interlateral-aligned receipts / authority cards

Trust Handoff Protocol v0 (identity, principal, authority scope, task
scope, source manifest, confidence, known limitations, human
approvals, data sensitivity, reversibility, expiration). Artifact
Maturity Ladder (Live Note → Working Paper). Room Done defaults to
Live Note / Discussion Paper honesty. Receipt v1 adds
`principalId`, `authorityClaimed`, `sourceManifest[]`,
`reversibility`, `expiration`. People-data ban held.

Research:
[ROOM-INTERLATERAL-RESEARCH-2026-09-17.md](ROOM-INTERLATERAL-RESEARCH-2026-09-17.md)

Contracts:

- [ROOM-TRUST-HANDOFF-V0.md](../docs/ROOM-TRUST-HANDOFF-V0.md)
- [ROOM-ARTIFACT-MATURITY.md](../docs/ROOM-ARTIFACT-MATURITY.md)

### G. Competitive / cousin landscape (research only)

Oasis, agensis, Agent Room, Alook, HumanLayer, Factory.ai, Dust.
Steal membership / authority / attention / artifact patterns. Room
stays the project ledger — not an IDE, marketplace, or canvas chat
hub. Closest name collision: Agent Room (coding-agent mesh).

Research:
[ROOM-COMPETITIVE-LANDSCAPE-2026-09-17.md](ROOM-COMPETITIVE-LANDSCAPE-2026-09-17.md)

### H. Ledger Room / receipt graph (novel synthesis)

The Room is the system of record for collaborative agentic work.
`room.receipt.v1` gains `id` + `citedReceiptIds[]`. When Agent B
relies on Agent A’s output, B cites A’s receipt id. Orphan claims
fail the scorer (`pass` / `orphan_claim` / `insufficient_citations`).

Research:
[ROOM-NOVEL-SYNTHESIS-2026-09-17.md](ROOM-NOVEL-SYNTHESIS-2026-09-17.md)

Contracts:

- [ROOM-RECEIPT-GRAPH-V0.md](../docs/ROOM-RECEIPT-GRAPH-V0.md)
- [orphan-claim](../docs/examples/scorers/orphan-claim/scorer.md)

Six-axis seat (identity · membership · authority · attention ·
memory · presence) stays on
[ROOM-ATTENTION-PRESENCE-V0.md](../docs/ROOM-ATTENTION-PRESENCE-V0.md).
People-rail chips are later Muse.

## Catalog face (not live doors)

[ROOM-KITS-CATALOG.md](../docs/ROOM-KITS-CATALOG.md) **Optional later**
rows only:

| Kit | Contract |
| --- | --- |
| Scorer (LLM-judge) | [ROOM-SCORER.md](../docs/ROOM-SCORER.md) |
| Skillbox-shaped library | [ROOM-KITS-HARNESS-JEV-ROY.md](../docs/ROOM-KITS-HARNESS-JEV-ROY.md) |
| Harness bridge | [ROOM-KITS-HARNESS-JEV-ROY.md](../docs/ROOM-KITS-HARNESS-JEV-ROY.md) |
| Connect Cua desktop | [ROOM-CUA-DESKTOP.md](../docs/ROOM-CUA-DESKTOP.md) ([#454](https://github.com/Uuriko/project-room/pull/454)) |
| Interlateral-aligned receipts / authority cards (visible authority cards = later face, **not People-rail HTML**) | [ROOM-TRUST-HANDOFF-V0.md](../docs/ROOM-TRUST-HANDOFF-V0.md) · [ROOM-RECEIPT-V1.md](../docs/ROOM-RECEIPT-V1.md) |

These rows never replace Join / Connect CTAs and are not a marketplace
shelf.

## Priority (no-collide)

1. **This PR** — steal contracts + example scorers + catalog rows +
   indexes. No client / door HTML.
2. **#454 merge** — Cua desktop contract + Fleet spike become the
   receipt backend those scorers judge.
3. **#457** — first steal map (Warp / Skillbox / harness-bridge). Keep
   both notes; this file is the build-out index.
4. Receipt runtime + scorer persona — later, after Muse board / kit
   ACK. Not this PR.
5. Skip hosting Skillbox / Warp Factories / Cua Fleet buttons now.

## Stay-outs

- `client/` · `cloudflare/` · `server/` · `src/` · `deploy/`
- Connect door HTML
- People rail
- Done-chip chrome
- Instinct Phase 0 [#8](https://github.com/Uuriko/project-room/pull/8) /
  [#9](https://github.com/Uuriko/project-room/pull/9)
- Quill trees
- Compute Start
- people-data in traces / screenshots
- auto-merge self-improve
- Potter keys
- Auto-billing Fleet without delete
- `--dangerously-skip-permissions` as a Room default (Interlateral OSS mesh does this; Room keeps Ask every time + Cua dual boundary)

## File list (this build-out)

| Path | Role |
| --- | --- |
| `research/ROOM-STEALS-FULL-BUILD-2026-09-17.md` | This master plan |
| `docs/ROOM-RECEIPT-V1.md` | `room.receipt.v1` contract |
| `docs/ROOM-SCORER.md` | Scorer kit contract |
| `docs/ROOM-PERSONAS-FACTORY.md` | Personas + factory parallelism |
| `docs/ROOM-KITS-HARNESS-JEV-ROY.md` | Kits / harness / Jev / Roy |
| `research/ROOM-HRANESS-STEAL-2026-09-17.md` | hraness factory steal |
| `research/ROOM-INTERLATERAL-RESEARCH-2026-09-17.md` | Interlateral → Room research (attached source) |
| `research/ROOM-COMPETITIVE-LANDSCAPE-2026-09-17.md` | Cousin landscape (Oasis / agensis / Agent Room / Alook / HumanLayer) |
| `research/ROOM-NOVEL-SYNTHESIS-2026-09-17.md` | Ledger Room novel synthesis |
| `docs/ROOM-RECEIPT-GRAPH-V0.md` | `citedReceiptIds[]` DAG; orphan claims fail |
| `docs/ROOM-TRUST-HANDOFF-V0.md` | Trust Handoff Protocol v0 |
| `docs/ROOM-ARTIFACT-MATURITY.md` | Five-rung artifact ladder |
| `docs/examples/scorers/*/scorer.md` | Five default scorer stubs (incl. orphan-claim) |
| `docs/ROOM-KITS-CATALOG.md` | Optional later rows |
| `research/README.md` | Index |
| `docs/README.md` | Index |
