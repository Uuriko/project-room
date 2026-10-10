// Board loading states (BU-02): every async board surface shows an honest
// loading state. Fail-first: these imports/assertions fail on the pre-fix
// board-ui.js, which renders a lying empty-board copy while loading and gives
// action buttons zero in-flight feedback.
import test from "node:test";
import assert from "node:assert/strict";
import { boardHtml, boardSkeletonHtml, pendingOutcome, installWorkBoard } from "../src/board-ui.js";

const NOW = Date.now();
const viewer = { id: "u1", manage: false, owner: false, write: true };
const claim = (id, extra = {}) => ({ id, title: id, state: "unclaimed", owner: null, dependsOn: [], ...extra });

// --- boardSkeletonHtml: decorative placeholder columns while the board loads ---

test("boardSkeletonHtml marks itself decorative and mirrors the five columns", () => {
  const html = boardSkeletonHtml();
  assert.ok(html.includes("board-skeleton"), "skeleton root class");
  assert.ok(html.includes('aria-hidden="true"'), "decorative for screen readers");
  for (const label of ["Ready", "Claimed / In progress", "Blocked", "In review", "Landed"]) {
    assert.ok(html.includes(label), `column label ${label}`);
  }
});

// --- pendingOutcome: honest in-flight copy for every board action ---

test("pendingOutcome narrates each action with the claim title", () => {
  const expected = {
    claim: "Claiming 'Fix login'…",
    renew: "Renewing 'Fix login'…",
    progress: "Marking 'Fix login' in progress…",
    done: "Marking 'Fix login' done…",
    release: "Releasing 'Fix login'…",
    close: "Closing 'Fix login'…",
    cancel: "Cancelling 'Fix login'…",
    reassign: "Reassigning 'Fix login'…",
    create: "Opening 'Fix login'…",
  };
  for (const [action, text] of Object.entries(expected)) {
    assert.equal(pendingOutcome(action, "Fix login"), text, action);
  }
});

test("pendingOutcome handles sweep (no title) and unknown actions", () => {
  assert.equal(pendingOutcome("sweep"), "Closing stale claims…");
  assert.equal(pendingOutcome("teleport", "x"), "");
});

// --- boardHtml loading: never show the lying empty copy while fetching ---

test("boardHtml with loading and no items shows the skeleton, not the empty copy", () => {
  const html = boardHtml([], null, viewer, {}, NOW, { loading: true, canWrite: true });
  assert.ok(html.includes("board-skeleton"), "skeleton while loading");
  assert.ok(html.includes("Loading the board…"), "honest status text");
  assert.ok(!html.includes("No work posted yet"), "no lying empty copy while loading");
  assert.ok(!html.includes("Claim work here"), "no lying empty copy while loading");
});

test("boardHtml with items still loading keeps stale items and says refreshing", () => {
  const items = [claim("a1", { title: "Write the notes" })];
  const html = boardHtml(items, null, viewer, {}, NOW, { loading: true, canWrite: true });
  assert.ok(html.includes("Write the notes"), "stale items stay visible");
  assert.ok(html.includes("Refreshing the board…"), "honest refresh note");
  assert.ok(!html.includes("board-skeleton"), "no skeleton over real items");
});

test("boardHtml with loadError and no items shows the error with a retry button", () => {
  const html = boardHtml([], null, viewer, {}, NOW, { loadError: true, canWrite: true });
  assert.ok(html.includes("Could not load the board."), "honest error copy");
  assert.ok(html.includes("data-board-retry"), "retry button present");
  assert.ok(html.includes("Try again"), "retry label");
  assert.ok(!html.includes("board-skeleton"), "no skeleton on error");
});

test("boardHtml default (no flags) keeps the existing empty-board behavior", () => {
  const shy = { id: null, manage: false, owner: false, write: false };
  const html = boardHtml([], null, shy, {}, NOW, { canWrite: false });
  assert.ok(html.includes("No work posted yet"), "empty copy preserved when not loading");
});

test("a failed refresh with a board already shown still says so, with retry", () => {
  const html = boardHtml([claim("a")], null, viewer, {}, NOW, { loadError: true, canWrite: true });
  assert.ok(html.includes("Could not load the board"));
  assert.ok(html.includes("data-board-retry"));
  assert.ok(html.includes('data-claim-id="a"') || html.includes("board-columns"), "stale board is kept");
});

// Controller regression: the live success message is a completion signal.
// The browser journey checks the actual DOM/focus/HTTP boundary; these held
// promises cover ordering that a fast response can hide there. No new exports.
function held() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function completionFixture(t) {
  const strict = value => new Proxy(value, {
    get(target, key) { assert.ok(key in target, `Unexpected API: ${String(key)}`); return target[key]; },
  });
  const mutation = held(), readback = held(), readArrived = held();
  const listeners = new Map();
  const line = { textContent: "" };
  const previous = { document: globalThis.document, CSS: globalThis.CSS, FormData: globalThis.FormData };
  const body = {};
  let html = "", posts = 0, session = { roomId: "commons", member: { id: "owner" } };
  const form = strict({ querySelector(selector) {
    assert.equal(selector, '[name="mine"]'); return { checked: false };
  } });
  const field = strict({
    name: "q", selectionStart: 5, selectionEnd: 5,
    closest(selector) { assert.equal(selector, "[data-board-filter]"); return form; },
    focus() { globalThis.document.activeElement = field; }, setSelectionRange() {},
  });
  const button = strict({
    dataset: { claimId: "notes", claimAction: "done", focusKey: "done:notes" },
    closest(selector) {
      assert.ok(["[data-board-retry]", "[data-board-filter-clear]", "[data-needs-me-open]", "[data-claim-action]"].includes(selector));
      return selector === "[data-claim-action]" ? button : null;
    },
    setAttribute(name, value) { assert.equal(name, "aria-busy"); assert.equal(value, "true"); },
    removeAttribute(name) { assert.equal(name, "aria-busy"); },
  });
  const root = strict({
    isConnected: true,
    addEventListener(type, listener) {
      assert.ok(["input", "click", "submit"].includes(type));
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    contains(node) { return node === button || node === form || node === field; },
    querySelector(selector) {
      if (selector === "#board-status") return line;
      if (selector === '[data-focus-key="board-filter-q"]') return field;
      assert.match(selector, /^(\[data-focus-key=|article\[data-claim-id=)/);
      return null;
    },
    set innerHTML(value) {
      html = value;
      line.textContent = /<p id="board-status"[^>]*>(.*?)<\/p>/.exec(value)?.[1] ?? "";
    },
    replaceChildren() { html = ""; line.textContent = ""; },
  });
  globalThis.document = strict({ activeElement: body, body, querySelector(selector) {
    assert.equal(selector, "#work-board"); return root;
  } });
  globalThis.CSS = strict({ escape: value => value });
  globalThis.FormData = class {
    constructor(value) { assert.equal(value, form); }
    get(name) { assert.equal(name, "q"); return "notes"; }
  };
  t.after(async () => {
    mutation.resolve({}); readback.resolve({ claims: [] });
    await new Promise(resolve => setImmediate(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  const item = claim("notes", { title: "Write the notes", state: "in_progress", owner: "owner",
    updatedAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 3600000).toISOString() });
  const client = strict({ generation: 1, path: path => path, request(path, options) {
    if (options?.method === "POST") {
      assert.equal(path, "/work-claims/notes/update"); assert.deepEqual(options.data, { state: "done" });
      posts++; return mutation.promise;
    }
    assert.equal(options, undefined);
    if (path === "/work-claims?limit=200") {
      if (posts) { readArrived.resolve(); return readback.promise; }
      return Promise.resolve({ claims: [item] });
    }
    if (path === "/work-claims/status") return Promise.resolve({ behind: 0 });
    if (path === "/work-claims/config") return Promise.resolve({ maxMemberOpenClaims: 20 });
    throw new Error(`Unexpected request: ${path}`);
  } });
  const board = installWorkBoard({ client,
    getState: () => ({ room: { ownerId: "owner" }, members: { owner: { id: "owner", active: true } }, eventLog: [] }),
    getSession: () => session });
  await board.whenReady();
  const click = () => listeners.get("click")[0]({ target: button });
  const filter = () => listeners.get("input")[0]({ target: field });
  const settled = () => new Promise(resolve => setImmediate(resolve));
  return { board, mutation, readback, readArrived, item, click, filter, settled,
    signOut() { session = null; board.reset(); },
    status: () => line.textContent, html: () => html, posts: () => posts };
}

test("Board completion is announced with fresh claims, never during held writes, reads or filter paints", async t => {
  const f = await completionFixture(t);
  f.click();
  assert.equal(f.status(), "Marking 'Write the notes' done…");
  f.filter();
  assert.notEqual(f.status(), "Done 'Write the notes'", "filtering during the POST cannot announce completion");
  f.click();
  assert.equal(f.posts(), 1, "a pending action excludes duplicate writes");
  f.mutation.resolve({});
  await f.readArrived.promise;
  assert.notEqual(f.status(), "Done 'Write the notes'", "readback has not arrived");
  f.filter();
  assert.notEqual(f.status(), "Done 'Write the notes'", "filtering during readback cannot announce completion");
  assert.match(f.html(), /class="claim-lease"/, "the stale card still has its lease");
  f.readback.resolve({ claims: [{ ...f.item, state: "done" }] });
  await f.settled();
  assert.equal(f.status(), "Done 'Write the notes'");
  assert.doesNotMatch(f.html(), /class="claim-lease"/);
  f.filter();
  assert.equal(f.status(), "Done 'Write the notes'", "completed status survives a later filter paint");
});

test("Board readback failure reports an error without a deferred success leaking into a later paint", async t => {
  const f = await completionFixture(t);
  f.click(); f.mutation.resolve({}); await f.readArrived.promise;
  assert.notEqual(f.status(), "Done 'Write the notes'");
  f.readback.reject(new Error("Readback unavailable")); await f.settled();
  assert.match(f.html(), /Could not load the board/);
  f.filter();
  assert.notEqual(f.status(), "Done 'Write the notes'");
  assert.match(f.html(), /class="claim-lease"/);
});

for (const phase of ["write", "readback"]) test(`Board reset retires completion during a held ${phase}`, async t => {
  const f = await completionFixture(t);
  f.click();
  if (phase === "readback") { f.mutation.resolve({}); await f.readArrived.promise; }
  f.signOut();
  f.mutation.resolve({}); f.readback.resolve({ claims: [{ ...f.item, state: "done" }] });
  await f.settled();
  assert.equal(f.html(), "");
  assert.equal(f.status(), "");
  assert.equal(f.posts(), 1);
});
