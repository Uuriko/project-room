# Conformance pilot (skeleton)

Isolated package, same shape as `contribution-rollup/`: own `package.json`, no Phase 0 imports.

**Design / skeleton only.** Grok mule task 53. This directory names the intended run. It does not execute it.

Full run is **blocked on a published [#8](https://github.com/Uuriko/project-room/pull/8) tip**. No merge until the Instinct tip. Do not merge [#17](https://github.com/Uuriko/project-room/pull/17) into this branch. Do not edit `server/` or `src/`.

Follows the intent of ROOM-CONFORMANCE-PILOT-DESIGN: an isolated conformance package that later exercises recovery, honesty, C1–C4 verification-first, and Contributors Events-only — without touching Phase 0 hot paths.

## Contract pointers

| Document | Why the pilot reads it |
| --- | --- |
| [EVENT-FIXTURES](../docs/EVENT-FIXTURES.md) | Recovery cases, producer/reporter honesty, C1–C4 contribution stubs |
| [SPEC-v0](../docs/SPEC-v0.md) | Object model, runtime/recovery, acceptance |
| [SERVICE](https://github.com/Uuriko/project-room/blob/instinct/integration-2026-09-06/docs/SERVICE.md) | Phase 0 service pilot: restart, WAL, honest limits. Lives on the #8 tip; not copied here |

`docs/SERVICE.md` is not on `main`. Point at the published #8 tip when Instinct publishes it. Do not vendor the service.

## Checklist (not yet executed)

1. **Recovery** — second member without a recap; unavailable worker; restart replay from Events; one logical receipt.
2. **Honesty** — unknown producer stays a gap; no invented PASS, merge, metric, or approval.
3. **C1–C4 verification-first** — happy / double-count / forged actor / unknown producer; designated verifier PASS before `complete` / `artifact` weight.
4. **Contributors Events-only** — read-model over existing Events. Message / ack volume adds no weight. No scoreboard.

## Stub interface (not #17)

`contributorsForReturnBrief(events, options)` is a **conceptual** stub of the #17 export: `{ lines, gaps, member_shares, active_weight }`. Weight kinds are `complete` / `verify` / `decide` / `artifact` only. This file does not import or rewrite `contribution-rollup`.

## Run

```sh
cd conformance-pilot
npm test
```

Passing tests document the checklist and isolation. One failing placeholder records that the full run has not executed.

## Out of scope

- Phase 0 `server/` / `src/` edits, and #8 / #9 hot paths
- Merging #17, #8, or #9
- Identity D235, Arcade, Multichain, getdasha Worker
- Payout, wallets, Compute credits, invented proceeds
- A live `/room` page

Coordination: [issue #11](https://github.com/Uuriko/project-room/issues/11). Merge / deploy stay with the owner.
