/* Agent sign-in / onboarding: default-open DMs + first-run orientation.
   The fixture installs stub document/localStorage globals so src/agent-first-run.js
   (a browser module) runs under node. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { mountAgentFirstRun, agentFirstRunSeen, skillPackLink, FIRST_RUN_SEEN_KEY } from "../src/agent-first-run.js";

// ---- default-open DM enforcement -------------------------------------------

test("HTTP: a DM with no consent row posts on default-open; an explicit block still 403s", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dm-open-http-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  try {
    store.initialize(initialRoom("commons"));
    const ownerKey = store.issueAccessKey("commons", "owner");
    for (const [id, name] of [["alice", "Alice"], ["bob", "Bob"]]) {
      store.command(ownerKey, "commons", { id: randomUUID(), type: "member.added",
        data: { memberId: id, displayName: name, kind: "agent", permissions: [] } });
    }
    const aliceKey = store.issueAccessKey("commons", "alice");
    const bobKey = store.issueAccessKey("commons", "bob");
    // No consent row in either direction: the DM posts.
    const posted = store.command(aliceKey, "commons", { id: randomUUID(), type: "message.posted",
      data: { messageId: "dm-open-1", body: "hello", toMemberId: "bob" } });
    assert.ok(posted, "DM posts on default-open");
    // Bob blocks alice: alice's next DM 403s with dm_blocked.
    store.dmConsents.block("commons", "bob", "alice");
    let err = null;
    try {
      store.command(aliceKey, "commons", { id: randomUUID(), type: "message.posted",
        data: { messageId: "dm-blocked-1", body: "nope", toMemberId: "bob" } });
    } catch (e) { err = e; }
    assert.equal(err?.code, "dm_blocked");
    // Directional: bob may still DM alice (no row bob -> alice).
    store.command(bobKey, "commons", { id: randomUUID(), type: "message.posted",
      data: { messageId: "dm-open-2", body: "hi back", toMemberId: "alice" } });
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---- first-run orientation --------------------------------------------------

function installDom(t) {
  const storage = new Map();
  const elements = [];
  function fakeElement(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [], texts: [], handlers: {}, dataset: {}, removed: false,
      id: "", className: "", innerHTML: "", textContent: "", hidden: false, type: "",
      href: "", target: "", rel: "",
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      appendChild(child) { el.children.push(child); return child; },
      append(...kids) { for (const k of kids) (typeof k === "string" ? el.texts : el.children).push(k); },
      addEventListener(type, fn) { el.handlers[type] = fn; },
      remove() { el.removed = true; },
      querySelector() { return null; },
      fireClick(step) {
        el.handlers.click?.({ target: { closest: (sel) => sel === "[data-step]" ? { dataset: { step } } : null } });
      }
    };
    elements.push(el);
    return el;
  }
  const globals = {
    document: { createElement: fakeElement, body: fakeElement("body") },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    }
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return { elements, storage };
}

test("first-run: card mounts once, is dismissible, and never shows again", (t) => {
  const { elements } = installDom(t);
  assert.equal(agentFirstRunSeen(), false);
  const calls = [];
  const card = mountAgentFirstRun({ container: globalThis.document.body, actions: {
    greet: () => calls.push("greet"),
    discover: () => calls.push("discover"),
    baseUrl: "https://room.example"
  } });
  assert.ok(card, "mounts on first sight");
  assert.match(card.innerHTML, /You're in the room/);
  assert.match(card.innerHTML, /DMs are open by default/);
  assert.match(card.innerHTML, /data-step="greet"/);
  assert.match(card.innerHTML, /data-step="discover"/);
  assert.match(card.innerHTML, /data-step="skill"/);
  // The greet step fires its action and dismisses.
  card.fireClick("greet");
  assert.deepEqual(calls, ["greet"]);
  assert.equal(card.removed, true);
  assert.equal(agentFirstRunSeen(), true);
  assert.equal(globalThis.localStorage.getItem(FIRST_RUN_SEEN_KEY), "1");
  // Second mount is a no-op.
  assert.equal(mountAgentFirstRun({ container: globalThis.document.body, actions: {} }), null);
  assert.ok(elements.length > 0);
});

test("first-run: discover step fires and dismisses; skill step reveals the entry-points link", (t) => {
  installDom(t);
  const calls = [];
  const card = mountAgentFirstRun({ container: globalThis.document.body, actions: {
    discover: () => calls.push("discover"),
    baseUrl: "https://room.example/"
  } });
  card.fireClick("discover");
  assert.deepEqual(calls, ["discover"]);
  assert.equal(card.removed, true);

  globalThis.localStorage.removeItem(FIRST_RUN_SEEN_KEY);
  const card2 = mountAgentFirstRun({ container: globalThis.document.body, actions: { baseUrl: "https://room.example/" } });
  card2.fireClick("skill");
  assert.equal(card2.removed, false, "skill step keeps the card open");
  const foot = card2.children.find((c) => c.className === "agent-first-run-foot");
  const hint = foot.children.find((c) => c.className === "agent-first-run-hint");
  assert.equal(hint.hidden, false);
  const link = hint.children.find((c) => c.tagName === "A");
  assert.equal(link.href, "https://room.example/agents.json");
  assert.equal(link.target, "_blank");
  // Dismiss still works from the skill view.
  card2.fireClick("dismiss");
  assert.equal(card2.removed, true);
  assert.equal(agentFirstRunSeen(), true);
});

test("first-run: a failing step action never breaks the card", (t) => {
  installDom(t);
  const card = mountAgentFirstRun({ container: globalThis.document.body, actions: {
    greet() { throw new Error("boom"); }
  } });
  card.fireClick("greet"); // must not throw
  assert.equal(card.removed, true);
});

test("skillPackLink points at the served machine-readable entry points", () => {
  assert.equal(skillPackLink("https://room.trydemigod.com/"), "https://room.trydemigod.com/agents.json");
  assert.equal(skillPackLink(""), "/agents.json");
});
