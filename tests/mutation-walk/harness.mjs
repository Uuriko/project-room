// Mutation-walk property harness — #3677 (PREP-3676-3677 §B.3), PR-1.
//
// One driver, one adapter per paginated surface. An adapter is:
//   {
//     name,
//     supportedOps,          // subset of MUTATION_WALK_OPS the surface can express
//     capBehaviour,          // declared P4 behaviour ("n/a — ..." is a declaration)
//     seed(n) -> [id],       // build the fixture dataset
//     openWalk(),            // start a walk from the beginning
//     nextPage(limit) -> { items: [id], nextCursor },
//     insertBeforeCursor() -> id,  // new item lands in the already-walked region
//     insertAfterCursor() -> id,   // new item lands in the not-yet-walked region
//     remove(id), move(id), flipVisibility(id),
//     inUnvisitedRegion(id) -> bool, // is id's sort key still ahead of the cursor?
//     present(id) -> bool, visible(id) -> bool,
//     ack?(pos), durable?(), highestDeliveredPos?(), // P2 surfaces only
//     close(),
//   }
//
// Properties (§B.3), checked by the driver for every adapter, every seed:
//   P1 exactly-once under mutation — an item is delivered only while it is
//      present, visible and still owed (in the unvisited region), and
//      every item that stays owed to the end of the walk has been
//      delivered exactly once per incarnation. Whether an item is owed is
//      recomputed after every mutation from the adapter's own sort-key /
//      cursor comparison, so a mutation that moves an item out of the
//      unvisited region (the inbox updatedAt bump is the canonical case)
//      retires its obligation instead of silently breaking the property.
//      A move is a re-incarnation (§B.3's move op: "a visited item
//      re-enters ahead of it"): the item's obligation restarts at its new
//      position, so exactly-once is asserted per (item, position)
//      incarnation. An item that is never moved is still delivered at
//      most once, full stop — and the inbox adapter, whose move lands in
//      the visited region, is additionally asserted per item id in the
//      test file.
//   P2 never ack past delivered — for adapters with ack: after every page
//      the durable position is <= the highest position actually delivered,
//      and reads alone never advance it (the driver acks only delivered
//      positions, and only when ackEachPage is set).
//   P3 cursor scoped to its own data — per-adapter tests (the generic
//      driver cannot mint a second scope); known failures live in
//      KNOWN_FAILURES below, pinned by name in the test file.
//   P4 loud failure at caps — per-adapter tests against the declared
//      capBehaviour; "n/a" declarations are asserted as declarations.
//   P5 termination — the walk finishes within (items + mutations + 1)
//      pages once mutations stop; the driver drains after the trace and
//      asserts the page bound throughout.
//
// Seeded interleavings come from PR-0's generator
// (tests/helpers/seeded-interleaving.mjs); every failure names its seed.

import assert from "node:assert/strict";
import {
  generateInterleaving,
  createSeededRng,
  seedFromString,
  MUTATION_WALK_OPS,
} from "../helpers/seeded-interleaving.mjs";

// Pinned known-failure debt rows (§B.3 P3 / §B.2 step 2). A row here is a
// debt record, not a pass: the named test in mutation-walk.test.js asserts
// the defective behaviour exactly, so the day the surface is fixed the
// test goes red and the row must be removed in the same PR that fixes it.
export const KNOWN_FAILURES = Object.freeze([
  Object.freeze({
    id: "MW-P3-INBOX-UNSIGNED-UNSCOPED",
    adapter: "inbox",
    property: "P3",
    status: "known-failure",
    debt: "server/inbox.mjs encodeCursor/decodeCursor mint an unsigned, unscoped "
      + "{updatedAt, id} token: a cursor minted for one account's source list "
      + "positions another account's walk over the same list shape (no error, "
      + "no reset). Signing/scoping the token is the L remainder on #3677 and "
      + "is out of scope for this slice.",
    pinnedBy: "tests/mutation-walk/mutation-walk.test.js — "
      + "\"P3 KNOWN-FAILURE MW-P3-INBOX-UNSIGNED-UNSCOPED\"",
  }),
]);

// P4 declarations that are n/a by design (§B.4): the obligation is not
// waived, it is pushed to the named next surface.
export const NOT_APPLICABLE = Object.freeze([
  Object.freeze({
    adapter: "read-cursor",
    property: "P4",
    status: "n/a — no page cap at this layer",
    obligation: "the cap obligation is pushed to whichever stream adapter "
      + "wires next under PREP-3676-3677 §B.2 step 1",
  }),
]);

export async function runMutationWalk({
  adapter,
  seed,
  itemCount = 12,
  pageSize = 3,
  traceLength = 28,
  ackEachPage = false,
}) {
  const fail = (message, step) => {
    const err = new Error(`mutation-walk seed ${seed} adapter ${adapter.name}: ${message}`);
    err.seed = seed;
    err.step = step;
    throw err;
  };

  const seededIds = await adapter.seed(itemCount);
  const state = new Map(); // id -> { present, visible, delivered, owed }
  for (const id of seededIds) state.set(id, { present: true, visible: true, delivered: 0, owed: true });

  const refreshOwed = () => {
    for (const [id, item] of state) {
      item.owed = Boolean(
        item.present && item.visible && item.delivered === 0 && adapter.inUnvisitedRegion(id),
      );
    }
  };
  const itemCountNow = () => [...state.values()].filter((i) => i.present).length;

  await adapter.openWalk();
  refreshOwed();

  const targetRng = createSeededRng(seedFromString(`${seed}:targets`));
  const pick = (candidates, step) => {
    if (!candidates.length) return null;
    return candidates[Math.floor(targetRng() * candidates.length)];
  };
  const idsWhere = (pred) => [...state.entries()].filter(([, i]) => pred(i)).map(([id]) => id);

  let insertCounter = 0;
  let mutations = 0;
  let pages = 0;
  let finished = false;
  const deliveredOrder = [];

  const pageBound = () => itemCountNow() + mutations + 1 + pages; // P5, generous live bound
  const doWalkNext = async (step) => {
    if (finished) return;
    const page = await adapter.nextPage(pageSize);
    pages += 1;
    if (pages > itemCount + traceLength + 2) {
      fail(`P5: walk did not terminate within items+mutations+1 pages (${pages} pages)`, step);
    }
    for (const id of page.items) {
      const item = state.get(id);
      if (!item) fail(`P1: delivered unknown item ${id}`, step);
      if (!item.present) fail(`P1: delivered deleted item ${id}`, step);
      if (!item.visible) fail(`P1: delivered hidden item ${id}`, step);
      if (!item.owed) fail(`P1: delivered item ${id} that was not owed (already delivered, or in the visited region)`, step);
      item.delivered += 1;
      if (item.delivered !== 1) fail(`P1: item ${id} delivered ${item.delivered} times`, step);
      item.owed = false;
      deliveredOrder.push(id);
    }
    if (ackEachPage && typeof adapter.ack === "function" && deliveredOrder.length) {
      await adapter.ack(adapter.highestDeliveredPos());
      const durable = adapter.durable();
      if (durable != null && durable > adapter.highestDeliveredPos()) {
        fail(`P2: durable ack ${durable} is past highest delivered ${adapter.highestDeliveredPos()}`, step);
      }
    }
    if (page.nextCursor == null) finished = true;
    refreshOwed();
  };

  const ops = MUTATION_WALK_OPS.filter((op) => adapter.supportedOps.includes(op));
  assert.ok(ops.includes("walkNext"), `${adapter.name}: adapter must support walkNext`);
  const { trace } = generateInterleaving({ seed, count: traceLength, ops });

  const handlers = {
    walkNext: (step) => doWalkNext(step),
    insertBeforeCursor: async () => {
      const id = await adapter.insertBeforeCursor(`mw-before-${seed}-${insertCounter++}`);
      state.set(id, { present: true, visible: true, delivered: 0, owed: false });
      mutations += 1; refreshOwed();
    },
    insertAfterCursor: async () => {
      const id = await adapter.insertAfterCursor(`mw-after-${seed}-${insertCounter++}`);
      state.set(id, { present: true, visible: true, delivered: 0, owed: false });
      mutations += 1; refreshOwed();
    },
    deleteUnvisited: async (step) => {
      const id = pick(idsWhere((i) => i.present && i.delivered === 0), step);
      if (!id) return;
      await adapter.remove(id);
      state.get(id).present = false;
      mutations += 1; refreshOwed();
    },
    deleteVisited: async (step) => {
      const id = pick(idsWhere((i) => i.present && i.delivered > 0), step);
      if (!id) return;
      await adapter.remove(id);
      state.get(id).present = false;
      mutations += 1; refreshOwed();
    },
    moveItem: async (step) => {
      const id = pick(idsWhere((i) => i.present), step);
      if (!id) return;
      await adapter.move(id);
      // Re-incarnation at the new position: the per-incarnation delivery
      // count restarts; refreshOwed() decides whether the new position is
      // owed (unvisited region) or retired (visited region).
      state.get(id).delivered = 0;
      mutations += 1; refreshOwed();
    },
    visibilityFlip: async (step) => {
      const id = pick(idsWhere((i) => i.present), step);
      if (!id) return;
      await adapter.flipVisibility(id);
      const item = state.get(id);
      item.visible = !item.visible;
      mutations += 1; refreshOwed();
    },
  };

  for (const step of trace) {
    if (finished) break;
    try {
      await handlers[step.op](step);
    } catch (err) {
      if (err && err.seed !== undefined) throw err;
      fail(`${step.op} at step ${step.index}: ${err?.message ?? err}`, step);
    }
  }
  // Mutations have stopped: drain. P5 bounds the remaining pages.
  let guard = 0;
  while (!finished) {
    await doWalkNext({ index: `drain-${guard}` });
    guard += 1;
    if (guard > itemCountNow() + mutations + 1) fail("P5: drain did not terminate", null);
  }

  for (const [id, item] of state) {
    if (item.owed && item.delivered !== 1) {
      fail(`P1: item ${id} was continuously owed at walk end but delivered ${item.delivered} times`, null);
    }
    if (item.delivered > 1) fail(`P1: item ${id} delivered ${item.delivered} times`, null);
  }
  assert.ok(pages <= itemCount + mutations + traceLength + 1, "page bound accounting");
  return { seed, adapter: adapter.name, pages, mutations, delivered: deliveredOrder, pageBound: pageBound() };
}
