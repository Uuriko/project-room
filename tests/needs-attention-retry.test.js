// E-H1: needs-attention fetch failure must be visible and retryable.
// Regression test for the bug where refresh()'s catch wrote the error into
// the hidden section (whose Refresh button lives inside it) and scheduled
// no retry — so an owner whose first fetch failed saw nothing all session.
//
// Test audit gate:
// 1. Protects: on fetch failure the section unhides (error + Refresh become
//    visible) and an automatic retry is scheduled.
// 2. Fails when: the catch block no longer unhides the section, or no retry
//    is scheduled (e.g. someone removes scheduleRetry()).
// 3. No existing test covers src/needs-attention.js at all.
// 4. No production seam added: the module already takes { client, section };
//    the test supplies fakes for both, plus a stub document.activeElement.
import test from "node:test";
import assert from "node:assert/strict";
import { createNeedsAttentionCard } from "../src/needs-attention.js";

function stubElement() {
  return {
    hidden: false,
    disabled: false,
    innerHTML: "",
    textContent: "",
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {},
    addEventListener() {},
    querySelectorAll: () => [],
    closest: () => null,
    focus() {},
  };
}

function makeSection() {
  const elements = {
    "#attention-list": stubElement(),
    "#attention-count": stubElement(),
    "#attention-status": stubElement(),
    "#attention-refresh": stubElement(),
    "#attention-pages": stubElement(),
    "#attention-range": stubElement(),
    "#attention-previous": stubElement(),
    "#attention-next": stubElement(),
  };
  return {
    hidden: true, // authored hidden, like index.html
    querySelector: sel => elements[sel] ?? stubElement(),
    _elements: elements,
  };
}

function makeClient({ failWith = null } = {}) {
  let calls = 0;
  return {
    session: { id: "sess-1" },
    generation: 1,
    calls: () => calls,
    needsAttention: async () => {
      calls++;
      if (failWith) throw failWith;
      return { items: [], itemCount: 0, pageOffset: 0 };
    },
  };
}

test("failed refresh unhides the section so the error and Refresh button are visible", async () => {
  const section = makeSection();
  const client = makeClient({ failWith: new Error("network down") });
  const card = createNeedsAttentionCard({ client, section });
  // Stub document.activeElement used by refresh(), and timers so the
  // scheduled retry doesn't fire after the test with a torn-down document.
  const prevDocument = globalThis.document;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.document = { activeElement: null };
  globalThis.setTimeout = () => 0;
  globalThis.clearTimeout = () => {};
  try {
    await card.refresh();
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
  assert.equal(section.hidden, false, "section unhidden on fetch failure");
  const status = section._elements["#attention-status"].textContent;
  assert.match(status, /Could not load: network down/, "error is reported in the status line");
});

test("failed refresh schedules an automatic retry", async () => {
  const section = makeSection();
  const client = makeClient({ failWith: new Error("timeout") });
  const card = createNeedsAttentionCard({ client, section });

  // Capture the scheduled retry instead of waiting 30s.
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => { const id = timers.length; timers.push({ fn, ms }); return id; };
  globalThis.clearTimeout = id => { if (timers[id]) timers[id] = null; };
  const prevDocument = globalThis.document;
  globalThis.document = { activeElement: null };
  try {
    await card.refresh();
    assert.equal(timers.filter(Boolean).length, 1, "one retry scheduled after failure");
    assert.ok(timers[0].ms >= 1000, `retry delay is sane (${timers[0].ms}ms)`);

    // Fire the retry: with the client now healthy it succeeds and hides the
    // empty section again (render() hides when there are no items).
    client.needsAttention = async () => { return { items: [], itemCount: 0, pageOffset: 0 }; };
    const retryFn = timers[0].fn;
    timers[0] = null;
    await retryFn();
    assert.equal(section.hidden, true, "section hides again after successful retry with no items");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
});

test("manual refresh supersedes a scheduled retry (no double fetch)", async () => {
  const section = makeSection();
  let calls = 0;
  const client = {
    session: { id: "sess-1" },
    generation: 1,
    needsAttention: async () => { calls++; throw new Error("flaky"); },
  };
  const card = createNeedsAttentionCard({ client, section });

  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => { const id = timers.length; timers.push({ fn, ms }); return id; };
  globalThis.clearTimeout = id => { if (timers[id]) timers[id] = null; };
  const prevDocument = globalThis.document;
  globalThis.document = { activeElement: null };
  try {
    await card.refresh(); // fails, schedules retry #1
    assert.equal(calls, 1);
    assert.equal(timers.filter(Boolean).length, 1);
    await card.refresh(); // manual retry: must clear the scheduled one first
    assert.equal(calls, 2);
    assert.equal(timers.filter(Boolean).length, 1, "only the latest retry remains scheduled");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
});

// MEMBER-PERMS controller-boundary audit:
// - Protect current-state authority, private-card teardown during outstanding
//   reads, the admin queue fallback, and the reader's chosen continuation.
// - Regressions include using a stale session member when getState is empty,
//   rendering a late response after authority loss, or resetting a manual page
//   on every room sync. The legacy tests above cover only retry behavior.
// - These use the production controller's existing dependencies and observable
//   card output; no production exports or test-only switches are introduced.
function attentionEnvironment(t) {
  const previousDocument = globalThis.document;
  const setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout;
  const timers = new Map();
  let timerId = 0;
  globalThis.document = { activeElement: null };
  globalThis.setTimeout = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    globalThis.setTimeout = setTimer;
    globalThis.clearTimeout = clearTimer;
  });
  const section = makeSection();
  section._elements["#attention-list"].replaceChildren = (...children) => {
    assert.equal(children.length, 0, "this fixture supports clearing list children only");
    section._elements["#attention-list"].innerHTML = "";
  };
  section.querySelector = selector => {
    assert.ok(Object.hasOwn(section._elements, selector), `unexpected card selector: ${selector}`);
    return section._elements[selector];
  };
  return { section, timers };
}

function attentionState({ owner = false } = {}) {
  return {
    room: { id: "room-1", ownerId: owner ? "admin-1" : "owner-1" },
    members: { "admin-1": { id: "admin-1", active: true, permissions: ["manage_members", "accept_work"] } },
  };
}

function accessQueue(displayName = "Pending member") {
  return { roomId: "room-1", requests: [{ requestId: "request-1", kind: "permissions", displayName,
    requestedPermissions: ["accept_work", "complete_work"] }] };
}

function attentionClient({ read = async () => null, queue = async () => accessQueue() } = {}) {
  const calls = { rollup: [], queue: [] };
  const client = new Proxy({
    session: { id: "sess-current", roomId: "room-1", member: { id: "admin-1", active: true, permissions: ["manage_members", "accept_work", "complete_work"] } },
    generation: 1,
    sequence: 1,
    ownsAccountSession: () => true,
    needsAttention: cursor => { calls.rollup.push(cursor); return read(cursor); },
    path: path => {
      assert.match(path, /^\/access-requests(?:\?status=pending|\/request-1\/decide)$/, "only access-request paths are supported");
      return `/api/rooms/room-1${path}`;
    },
    request: (path, options) => {
      assert.equal(path, "/api/rooms/room-1/access-requests?status=pending", "only the authorized pending queue may be fetched");
      assert.equal(options, undefined, "queue fetch must remain read-only");
      calls.queue.push(path);
      return queue();
    },
  }, {
    get(target, name, receiver) {
      if (!Reflect.has(target, name)) throw new Error(`Unexpected client operation: ${String(name)}`);
      return Reflect.get(target, name, receiver);
    },
  });
  return { client, calls };
}

function assertAttentionCleared(section) {
  const elements = section._elements;
  assert.equal(section.hidden, true, "private card is hidden");
  assert.equal(elements["#attention-list"].innerHTML, "", "private content and decision controls are removed");
  assert.equal(elements["#attention-count"].textContent, "");
  assert.equal(elements["#attention-range"].textContent, "");
  assert.equal(elements["#attention-status"].textContent, "", "no private status or late error remains");
  assert.equal(elements["#attention-pages"].hidden, true);
  assert.equal(elements["#attention-previous"].disabled, true);
  assert.equal(elements["#attention-next"].disabled, true);
  assert.equal(elements["#attention-refresh"].disabled, false, "teardown releases busy controls");
}

function deferredAttentionRead() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const [label, provider] of [
  ["null provider", null],
  ["undefined provider", undefined],
  ["null state", () => null],
  ["undefined state", () => undefined],
  ["missing current member", () => ({ room: { id: "room-1", ownerId: "admin-1" }, members: {} })],
  ["mismatched room", () => ({ ...attentionState(), room: { id: "other-room", ownerId: "admin-1" } })],
]) {
  test(`explicit ${label} fails closed despite a stale privileged session member`, async t => {
    const { section, timers } = attentionEnvironment(t);
    const { client, calls } = attentionClient();
    // Simulate authored/reused card markup before the controller's first read.
    section.hidden = false;
    section._elements["#attention-list"].innerHTML = "<button>Prior private request</button>";
    section._elements["#attention-status"].textContent = "Prior private status";
    const card = createNeedsAttentionCard({ client, section, getState: provider });
    await card.refresh();
    card.sync();
    assert.deepEqual(calls, { rollup: [], queue: [] }, "no owner rollup or queue read may start without current authority");
    assertAttentionCleared(section);
    assert.equal(timers.size, 0);
  });
}

test("current active admin renders the queue when the owner-only reader returns null", async t => {
  const { section, timers } = attentionEnvironment(t);
  const state = attentionState();
  const { client, calls } = attentionClient();
  client.session.member.permissions = []; // Current state, not this snapshot, authorizes the reviewer.
  const card = createNeedsAttentionCard({ client, section, getState: () => state });
  await card.refresh();
  assert.deepEqual(calls.rollup, [null]);
  assert.equal(calls.queue.length, 1);
  assert.equal(section.hidden, false);
  assert.equal(section._elements["#attention-count"].textContent, "1");
  assert.equal(section._elements["#attention-range"].textContent, "Showing 1–1 of 1");
  const markup = section._elements["#attention-list"].innerHTML;
  assert.match(markup, /Pending member wants more permissions/);
  assert.match(markup, /You cannot grant: complete_work/, "admin grant controls use current permissions");
  assert.equal(section._elements["#attention-status"].textContent, "");
  assert.equal(timers.size, 0);
});

for (const change of ["revoked", "inactive", "state removed"]) {
  for (const stage of ["rollup", "queue"]) {
    for (const outcome of ["success", "failure"]) {
      test(`${change} authority clears the card and suppresses late ${stage} ${outcome}`, async t => {
        const { section, timers } = attentionEnvironment(t);
        let state = attentionState();
        let inFlight = false;
        const pending = deferredAttentionRead(), entered = deferredAttentionRead();
        const hold = () => { entered.resolve(); return pending.promise; };
        const { client, calls } = attentionClient({
          read: async () => inFlight && stage === "rollup" ? hold() : null,
          queue: async () => inFlight && stage === "queue" ? hold() : accessQueue(),
        });
        const card = createNeedsAttentionCard({ client, section, getState: () => state });
        await card.refresh();
        assert.match(section._elements["#attention-list"].innerHTML, /Pending member/, "first prove private content was rendered");
        inFlight = true;
        const refresh = card.refresh();
        await entered.promise;
        assert.equal(section._elements["#attention-refresh"].disabled, true);
        if (change === "revoked") state.members["admin-1"].permissions = [];
        else if (change === "inactive") state.members["admin-1"].active = false;
        else state = null;
        // A response can win the race against the next UI sync. The read
        // completion itself must discard and clear newly unauthorized data.
        const queueReads = calls.queue.length;
        if (outcome === "failure") pending.reject(new Error("Late private queue error"));
        else pending.resolve(stage === "queue" ? accessQueue("Late private member") : null);
        await refresh;
        assertAttentionCleared(section);
        assert.equal(calls.queue.length, queueReads, "a stale owner-read completion cannot start a queue read");
        assert.equal(timers.size, 0, "a stale failure cannot schedule a retry");
        await card.refresh();
        assert.equal(calls.rollup.length, 2, "manual refresh cannot use stale session authority");
        assert.equal(calls.queue.length, queueReads);
      });
    }
  }
}

test("sync immediately clears a populated card while a revoked reviewer waits for a queue read", async t => {
  const { section, timers } = attentionEnvironment(t);
  const state = attentionState();
  const pending = deferredAttentionRead(), entered = deferredAttentionRead();
  let waitForQueue = false;
  const { client } = attentionClient({ queue: async () => {
    if (!waitForQueue) return accessQueue();
    entered.resolve();
    return pending.promise;
  } });
  const card = createNeedsAttentionCard({ client, section, getState: () => state });
  await card.refresh();
  assert.match(section._elements["#attention-list"].innerHTML, /Pending member/);
  waitForQueue = true;
  const refresh = card.refresh();
  await entered.promise;
  state.members["admin-1"].permissions = [];
  card.sync();
  assertAttentionCleared(section);
  pending.resolve(accessQueue("Late private member"));
  await refresh;
  assertAttentionCleared(section);
  assert.equal(timers.size, 0);
});

test("room sync preserves a manually selected page until the reader follows its stale continuation", async t => {
  const { section } = attentionEnvironment(t);
  const state = attentionState({ owner: true });
  const item = { kind: "decision", id: "decision-1", severity: "action", title: "Owner review", detail: "Review this decision", actions: [] };
  const { client, calls } = attentionClient({
    read: async cursor => ({ items: [item], itemCount: 3, pageOffset: cursor === "page-2" ? 1 : 0,
      previousCursor: cursor === "page-2" ? "page-1" : null,
      nextCursor: cursor === "page-2" ? "stale-page-3" : "page-2", reset: cursor === "stale-page-3" }),
    queue: async () => ({ roomId: "room-1", requests: [] }),
  });
  const card = createNeedsAttentionCard({ client, section, getState: () => state });
  card.sync(); // Establish current room scope; the manual read supersedes this initial read.
  await card.refresh("page-2");
  assert.equal(section._elements["#attention-range"].textContent, "Showing 2–2 of 3");
  assert.equal(section._elements["#attention-next"].disabled, false);
  const reads = calls.rollup.length, queueReads = calls.queue.length;
  client.sequence++;
  card.sync();
  assert.equal(calls.rollup.length, reads, "a room update does not replace the reader's page");
  assert.equal(calls.queue.length, queueReads);
  assert.equal(section._elements["#attention-range"].textContent, "Showing 2–2 of 3");
  await card.refresh("stale-page-3");
  assert.equal(calls.rollup.at(-1), "stale-page-3", "manual continuation still reaches the reader");
  assert.equal(section._elements["#attention-range"].textContent, "Showing 1–1 of 3");
  assert.equal(section._elements["#attention-status"].textContent, "The list changed. Showing the first page.");
});

// Ownership-transfer audit: manage_members survives the transfer, so the
// existing revoked/inactive cases cannot catch a retained owner-only report.
// These exercise the real sync/read-completion boundaries with distinct private
// owner data and public-to-admin queue data. The credible regressions are keeping
// a selected owner page, or joining a late response to that old owner's report.
// No new production dependency or test seam is needed.
function ownerTransferReport() {
  return {
    items: [
      { kind: "decision", id: "private-owner-decision", severity: "action", title: "Private owner decision",
        detail: "Owner-only review detail", actions: [{ action: "review", method: "GET" }] },
      { kind: "access_request", id: "request-1", severity: "action", title: "Pending member",
        detail: "Pending permission review", actions: [] },
    ],
    itemCount: 91,
    pageOffset: 20,
    previousCursor: "owner-page-1",
    nextCursor: "owner-page-3",
  };
}

function assertOwnerRollupRemoved(section) {
  const elements = section._elements;
  assert.doesNotMatch(elements["#attention-list"].innerHTML, /Private owner decision|Owner-only review detail|private-owner-decision/,
    "neither private owner content nor its review link survives ownership loss");
  assert.notEqual(elements["#attention-count"].textContent, "91", "owner-only totals are removed");
  assert.doesNotMatch(elements["#attention-range"].textContent, /of 91/, "owner-only page metadata is removed");
  assert.equal(elements["#attention-pages"].hidden, true, "owner continuations are removed");
  assert.equal(elements["#attention-previous"].disabled, true);
  assert.equal(elements["#attention-next"].disabled, true);
}

function assertAdminQueueRendered(section) {
  assertOwnerRollupRemoved(section);
  assert.equal(section.hidden, false, "the remaining admin can still review pending requests");
  assert.match(section._elements["#attention-list"].innerHTML, /Pending member wants more permissions/);
  assert.equal(section._elements["#attention-count"].textContent, "1");
  assert.equal(section._elements["#attention-range"].textContent, "Showing 1–1 of 1");
}

test("ownership transfer clears a selected owner page while preserving the active admin queue", async t => {
  const { section, timers } = attentionEnvironment(t);
  const state = attentionState({ owner: true });
  const { client } = attentionClient({ read: async () => state.room.ownerId === "admin-1" ? ownerTransferReport() : null });
  const card = createNeedsAttentionCard({ client, section, getState: () => state });
  card.sync(); // Establish the current room so the later sync is an authority change, not initial setup.
  await card.refresh("owner-page-2");
  assert.match(section._elements["#attention-list"].innerHTML, /Private owner decision/);
  assert.equal(section._elements["#attention-range"].textContent, "Showing 21–22 of 91");
  assert.equal(section._elements["#attention-next"].disabled, false);
  state.room.ownerId = "new-owner";
  client.sequence++;
  card.sync();
  assertOwnerRollupRemoved(section); // Must happen synchronously, before the next network response.
  assert.equal(state.members["admin-1"].active, true);
  assert.ok(state.members["admin-1"].permissions.includes("manage_members"));
  await card.refresh();
  assertAdminQueueRendered(section);
  assert.equal(timers.size, 0);
});

for (const stage of ["rollup", "queue"]) {
  test(`ownership transfer suppresses an in-flight owner ${stage} response even while admin authority remains`, async t => {
    const { section, timers } = attentionEnvironment(t);
    const state = attentionState({ owner: true });
    const pending = deferredAttentionRead(), entered = deferredAttentionRead();
    let holdRead = false;
    const hold = () => { entered.resolve(); return pending.promise; };
    const { client } = attentionClient({
      read: async () => holdRead && stage === "rollup" ? hold()
        : state.room.ownerId === "admin-1" ? ownerTransferReport() : null,
      queue: async () => holdRead && stage === "queue" ? hold() : accessQueue(),
    });
    const card = createNeedsAttentionCard({ client, section, getState: () => state });
    card.sync();
    await card.refresh("owner-page-2");
    assert.match(section._elements["#attention-list"].innerHTML, /Private owner decision/);
    holdRead = true;
    const refresh = card.refresh("owner-page-3");
    await entered.promise;
    state.room.ownerId = "new-owner";
    // No sync: an outstanding read may settle before the next UI update.
    pending.resolve(stage === "rollup" ? ownerTransferReport() : accessQueue());
    await refresh;
    assertOwnerRollupRemoved(section);
    assert.equal(state.members["admin-1"].active, true);
    assert.ok(state.members["admin-1"].permissions.includes("manage_members"));
    holdRead = false;
    await card.refresh();
    assertAdminQueueRendered(section);
    assert.equal(timers.size, 0);
  });
}
