# Invariant harness

A permanent CI gate for the room's never-break product invariants
("retry must not duplicate work", "failed actions preserve data",
"a release requires the holder's claim", ...). Every scenario here runs
against a **fresh disposable database** on every CI run — a prevention
layer, not a bug list.

This is intentionally separate from WAVE-300's replay harness, which is
sim-before-live for planned changes. This directory pins properties
that must hold on the real store, always.

## Files

| File | Purpose |
|---|---|
| `runner.mjs` | Boots a fresh DB per scenario (`bootInvariantDB`), runs the `runInvariant` / `invariantSuite` lifecycle, tears the DB down. |
| `dsl.mjs` | The scenario DSL: `invariant(id, title).given().when().then().build()`. |
| `fixtures.mjs` | Fixture helpers: `mintIdentity`, `linkToRoom`, `proposeWork`, `acceptWork`, `acquireClaim`, `releaseClaim`, `completeWork`, `workItemState`. |
| `harness-smoke.test.mjs` | Self-check of the frame (runner/DSL/fixtures mechanics). Not a product invariant. |
| `<topic>.test.mjs` | Where invariant scenarios live (written by the invariant-lane workers). |

## How to add an invariant

1. Create `tests/invariants/<topic>.test.mjs` (or add to an existing one).
   Name it for the property, e.g. `retry-semantics.test.mjs`.

2. Write the scenario in three phases — **declare → act → assert**:

```js
import assert from "node:assert/strict";
import { invariant } from "./dsl.mjs";
import { invariantSuite } from "./runner.mjs";
import { proposeWork, acceptWork, acquireClaim, releaseClaim, workItemState } from "./fixtures.mjs";

invariantSuite([
  invariant("release-requires-holder", "only the claim holder can release it")
    .given((f, ctx) => {
      // DECLARE the world. Do not perform the operation under test here.
      ctx.workItemId = proposeWork(f);
      acceptWork(f, ctx.workItemId);
      ctx.receipt = acquireClaim(f, ctx.workItemId, { actor: f.keys.owner });
      ctx.intruder = f.keys.producer;
      return ctx;
    })
    .when(async (f, ctx) => {
      // ACT: the exact operation the invariant covers.
      // If it is refused, the DSL captures the error as ctx.error.
      releaseClaim(f, ctx.workItemId, { actor: ctx.intruder });
    })
    .then((f, ctx) => {
      // ASSERT: pin the invariant. No new state changes here.
      assert.equal(ctx.error?.code, "work_claim_conflict");
      assert.equal(workItemState(f, f.keys.owner, ctx.workItemId).claim?.status, "active");
    })
    .build(),
]);
```

3. Phase rules:
   - `.given(f, ctx)` — preconditions only (identities, rooms, work items,
     claims). Return `ctx` (or mutate it).
   - `.when(f, ctx)` — the operation(s) under test. May be refused; a
     thrown error lands in `ctx.error` for the assert phase.
   - `.then(f, ctx)` — assertions on final state. Assert refusals via
     `ctx.error?.code` / `ctx.error?.status`, and assert state is
     unchanged where the invariant demands it.
   - Scenario ids must be unique and stable (`kebab-case`, no dates).

4. **Fail-first**: before opening the PR, verify the scenario goes red
   against a deliberately broken build (e.g. comment out the guard),
   then green with the guard restored. A scenario you have never seen
   fail is not done.

5. Run it:

```sh
node --test tests/invariants/
```

   The directory is picked up by the repo's normal `npm test`
   (`node --test`), so every scenario here is a permanent CI gate.

## Fixture notes

- `f` is the acceptance fixture (`createAcceptanceFixture()`); the room
  is `"commons"` and `f.keys.owner/producer/guest/agent/reviewer` exist.
- Each scenario gets its own disposable DB; the runner closes the store
  and deletes the directory in `t.after`.
- Keep scenarios fast and deterministic: no network, no wall-clock
  sleeps, no real timers.
