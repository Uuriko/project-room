import test from "node:test";
import assert from "node:assert/strict";
import { nameBeforeFirstRoom } from "../src/workspace-navigation.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("first-room setup deduplicates within the active session", async () => {
  const gate = deferred(); let asks = 0, ensures = 0;
  const run = nameBeforeFirstRoom({ session: () => "a", askName: () => { asks++; return gate.promise; },
    ensure: async () => { ensures++; return { room: { id: "a-room" } }; } });
  const first = run(); assert.equal(run(), first);
  gate.resolve(); assert.deepEqual(await first, { room: { id: "a-room" } });
  assert.equal(asks, 1); assert.equal(ensures, 1);
});

test("a new account starts independently and old completion cannot clear its flight", async () => {
  let current = "a"; const gates = { a: deferred(), b: deferred() }, created = [];
  const run = nameBeforeFirstRoom({ session: () => current, askName: () => gates[current].promise,
    ensure: async () => { created.push(current); return current; } });
  const old = run(); current = "b"; const fresh = run();
  assert.notEqual(fresh, old);
  gates.a.resolve(); assert.equal(await old, null);
  assert.equal(run(), fresh);
  gates.b.resolve(); assert.equal(await fresh, "b");
  assert.deepEqual(created, ["b"]);
});

test("logout does not open setup or create a room", async () => {
  let calls = 0;
  const run = nameBeforeFirstRoom({ session: () => null,
    askName: () => { calls++; }, ensure: () => { calls++; } });
  assert.equal(await run(), null); assert.equal(calls, 0);
});

test("changing account while creation completes suppresses the stale result", async () => {
  let current = "a"; const gate = deferred();
  const run = nameBeforeFirstRoom({ session: () => current, ensure: () => gate.promise });
  const old = run(); await Promise.resolve(); current = "b";
  gate.resolve({ room: { id: "a-private" } });
  assert.equal(await old, null);
});

test("a failed optional setup still creates, and a rejected creation can retry", async () => {
  let attempts = 0;
  const run = nameBeforeFirstRoom({ session: () => "a", askName: async () => { throw Error("optional"); },
    ensure: async () => { if (++attempts === 1) throw Error("offline"); return "ready"; } });
  await assert.rejects(run(), /offline/);
  assert.equal(await run(), "ready"); assert.equal(attempts, 2);
});

test("browsing rooms consumes an old sign-in destination without losing the app base path", async () => {
  const { installWorkspaceNavigation } = await import("../src/workspace-navigation.js");
  const originals = Object.fromEntries(["document", "location", "history"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const elements = new Map(); const visits = [];
  try {
    globalThis.document = { querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, { hidden: false, addEventListener() {} });
      return elements.get(selector);
    } };
    globalThis.location = { href: "https://example.test/room/?next=old-private&room=current&theme=dark#room/current" };
    globalThis.history = { pushState(_state, _title, path) { visits.push(path); } };
    const ui = installWorkspaceNavigation({ account: { session: { authenticated: true } },
      getRoom: () => ({ id: "current" }), onRooms() {}, onNavigate() {} });
    ui.showRoomList(true);
    assert.deepEqual(visits, ["/room/?theme=dark#pr-view/room-list"]);
    assert.equal(elements.get("#account-rooms-panel").hidden, false);
    assert.equal(elements.get("#main").hidden, true);
  } finally {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
