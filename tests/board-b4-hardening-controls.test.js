// B4-HARDENING (client, PR #4090): Dot's exact-head reproducers D4/D5/D6
// plus the client half of D3. Failing-first against 31f994f6b:
// - D6: claimSendBackBody derived the same requestId for a new round's
//   send-back as for round 1's (deliveryGeneration resets on release),
//   so a new-round send-back could replay round 1's recorded outcome.
// - D3 (client): claimReviewBody's expectedBasis omitted claimRound and
//   basisCurrent never compared it, so the board itself treated a
//   round-1 approval as current in round 2.
// - D4: a background work_claim.updated repaint (full innerHTML) wiped
//   unsent review/deliver/new-item form data and reset the verdict.
// - D5: the send-back click branch had no controller-level coverage —
//   the focused suites passed with the branch body deleted. The test
//   below drives the REAL delegated click listener and requires the
//   POST; deleting the branch makes it fail.
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkBoard, claimSendBackBody, claimReviewBody, currentApprovalFor } from "../src/board-ui.js";

const T0 = "2026-10-18T10:00:00.000Z";
const T1 = "2026-10-18T10:00:00.000Z"; // same-ms reclaim (D3's alias shape)
const DIGEST = "d".repeat(64);
const SHA = "a".repeat(64);

// ---------------------------------------------------------------- D6 (pure)

test("D6: a new round's send-back derives a different requestId than round 1's", () => {
  const round1 = { id: "wc_r", claimedAt: T0, deliveryGeneration: 1,
    history: [{ action: "created" }, { action: "claimed" }, { action: "state:delivered" }] };
  // Round 2: released and re-claimed at the SAME timestamp; the fresh
  // claim + re-delivery append history and reset the generation to 1.
  const round2 = { id: "wc_r", claimedAt: T1, deliveryGeneration: 1,
    history: [...round1.history, { action: "state:unclaimed" }, { action: "claimed" }, { action: "state:delivered" }] };
  const first = claimSendBackBody(round1, "rev-1");
  const second = claimSendBackBody(round2, "rev-1");
  assert.notEqual(second.requestId, first.requestId,
    "the round-2 send-back must not reuse round 1's operation identity");
  assert.match(second.requestId, /^sendback-wc_r-1-[0-9a-f]{16}-rev-1$/,
    "the id carries a round fingerprint segment like the other actions");
  // Retry stability within the round as rendered: same item, same id.
  assert.equal(claimSendBackBody(round2, "rev-1").requestId, second.requestId);
  // The basis fencing is unchanged.
  assert.equal(second.state, "in_progress");
  assert.equal(second.expectedClaimedAt, T1);
  assert.equal(second.expectedHistoryLength, 6);
});

// ------------------------------------------------------- D3 client (pure)

test("D3 (client): the review body names the claim round it read", () => {
  const item = { id: "wc_r", owner: "agent-1", claimedAt: T0, revision: null, ci: null,
    delivery: { digest: DIGEST }, deliveryGeneration: 1, claimRound: 2 };
  const body = claimReviewBody(item, "approve", "looks right");
  assert.equal(body.expectedBasis.claimRound, 2);
});

test("D3 (client): a round-1 approval is not current in round 2; legacy and same-round approvals are", () => {
  const attested = at => [{ memberId: "rev-1", at }];
  const approval = (basis, at = "2026-10-18T11:00:00.000Z") => ({ memberId: "rev-1", verdict: "approve", summary: "ok", at, basis });
  const base = { id: "wc_r", owner: "agent-1", claimedAt: T0, revision: null, ci: null,
    delivery: { digest: DIGEST }, deliveryGeneration: 1, state: "delivered" };
  const basisV1 = { version: 1, owner: "agent-1", claimedAt: T0, revision: null, headSha: null,
    deliveryDigest: DIGEST, deliveryGeneration: 1 };
  const round2 = { ...base, claimRound: 2 };
  const stale = { ...round2, reviews: [approval({ ...basisV1, claimRound: 1 })], attestations: attested("2026-10-18T11:00:00.000Z") };
  assert.equal(currentApprovalFor(stale, "rev-1"), null,
    "a round-1 approval must not offer Verify against round 2's delivery");
  const fresh = { ...round2, reviews: [approval({ ...basisV1, claimRound: 2 })], attestations: attested("2026-10-18T11:00:00.000Z") };
  assert.ok(currentApprovalFor(fresh, "rev-1"), "a round-2 approval is current in round 2");
  const round1 = { ...base, claimRound: 1 };
  const legacy = { ...round1, reviews: [approval(basisV1)], attestations: attested("2026-10-18T11:00:00.000Z") };
  assert.ok(currentApprovalFor(legacy, "rev-1"),
    "a pre-rounds (unstamped) basis still attests the first explicit round");
});

// ------------------------------------------- fake DOM (value-aware) ------
// A small hand-rolled parser for the board's machine-generated markup:
// enough DOM for the real controller — node replacement on innerHTML,
// field values as properties (typing changes the property, not the
// attribute), delegated listeners, and a FormData that reads live values.

function parseSelector(selector) {
  const match = /^([a-z][\w-]*)?(#[\w-]+)?((?:\[[\w-]+(?:="[^"]*")?\])*)$/.exec(selector);
  assert.ok(match, `unsupported selector: ${selector}`);
  const attrs = [];
  for (const attr of (match[3] ?? "").matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) attrs.push([attr[1], attr[2]]);
  return { tag: match[1] ?? null, id: match[2]?.slice(1) ?? null, attrs };
}

function matchesSelector(node, selector) {
  const { tag, id, attrs } = parseSelector(selector);
  if (tag && node.tag !== tag) return false;
  if (id && node.attrs.id !== id) return false;
  return attrs.every(([name, value]) => Object.hasOwn(node.attrs, name) && (value === undefined || node.attrs[name] === value));
}

function makeDom(t) {
  let nodes = [];
  const body = { tag: "body", attrs: {}, parent: null, children: [], closest: () => null };
  let active = body;
  const listeners = { input: [], click: [], submit: [] };
  const previous = { document: globalThis.document, CSS: globalThis.CSS, FormData: globalThis.FormData };

  const queryWithin = (scope, selector, all) => {
    const parts = selector.split(" ");
    assert.ok(parts.length <= 2, `unsupported selector: ${selector}`);
    const pool = scope === null ? nodes : nodes.filter(node => {
      for (let up = node.parent; up; up = up.parent) if (up === scope) return true;
      return false;
    });
    const found = pool.filter(node => matchesSelector(node, parts.at(-1))
      && (parts.length === 1 || node.parent?.closest(parts[0])));
    return all ? found : (found[0] ?? null);
  };

  const makeNode = (tag, attrs, parent) => {
    const node = { tag, attrs, parent, children: [], textContent: "", disabled: false, name: attrs.name, id: attrs.id,
      get dataset() {
        return Object.fromEntries(Object.entries(attrs).filter(([key]) => key.startsWith("data-"))
          .map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
      },
      closest(selector) { for (let up = this; up; up = up.parent) if (up.tag && matchesSelector(up, selector)) return up; return null; },
      querySelector(selector) { return queryWithin(this, selector, false); },
      querySelectorAll(selector) { return queryWithin(this, selector, true); },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      removeAttribute(name) { delete this.attrs[name]; },
      focus() { active = this; },
      scrollIntoView() {},
    };
    if (tag === "input" || tag === "textarea") {
      node._value = attrs.value ?? "";
      Object.defineProperty(node, "value", { get() { return this._value; }, set(value) { this._value = String(value); } });
      node.checked = Object.hasOwn(attrs, "checked");
      node.readOnly = false;
    }
    if (tag === "select") {
      Object.defineProperty(node, "value", {
        get() {
          if (this._value !== undefined) return this._value;
          const options = this.children.filter(child => child.tag === "option");
          const chosen = options.find(option => Object.hasOwn(option.attrs, "selected")) ?? options[0];
          return chosen?.attrs.value ?? "";
        },
        set(value) { this._value = String(value); },
      });
    }
    return node;
  };

  const parseInto = html => {
    nodes = [];
    if (nodes.includes(active)) active = body;
    active = body;
    const stack = [body];
    const token = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
    let match;
    while ((match = token.exec(html))) {
      if (match[5] !== undefined) { stack.at(-1).textContent += match[5]; continue; }
      const [, closing, tag, attrText, selfClose] = match;
      if (closing) { stack.pop(); continue; }
      const attrs = {};
      for (const attr of (attrText ?? "").matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[attr[1]] = attr[2] ?? "";
      const node = makeNode(tag, attrs, stack.at(-1));
      stack.at(-1).children.push(node);
      nodes.push(node);
      if (!selfClose && tag !== "input") stack.push(node);
    }
  };

  const root = {
    isConnected: true,
    addEventListener(type, listener) { listeners[type].push(listener); },
    contains: node => nodes.includes(node),
    querySelector: selector => queryWithin(null, selector, false),
    querySelectorAll: selector => queryWithin(null, selector, true),
    set innerHTML(html) { parseInto(html); },
    replaceChildren() { parseInto(""); },
  };
  class FakeFormData {
    constructor(form) { this.form = form; }
    fields() { return this.form.querySelectorAll("[name]"); }
    get(name) { const field = this.fields().find(entry => entry.attrs.name === name); return field ? field.value : null; }
    getAll(name) { return this.fields().filter(entry => entry.attrs.name === name).map(entry => entry.value); }
  }
  globalThis.document = { body, get activeElement() { return active; },
    querySelector: selector => (selector === "#work-board" ? root : null) };
  globalThis.CSS = { escape: value => value };
  globalThis.FormData = FakeFormData;
  t.after(async () => {
    await new Promise(resolve => setImmediate(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  return { root, listeners,
    query: selector => queryWithin(null, selector, false),
    fire: (type, target) => { for (const listener of listeners[type]) listener({ target, preventDefault() {} }); },
  };
}

const MEMBERS = {
  "agent-1": { id: "agent-1", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  "rev-1": { id: "rev-1", kind: "human", active: true, permissions: ["accept_work", "complete_work"] },
  "owner-x": { id: "owner-x", kind: "human", active: true, permissions: ["manage_claims"] },
};
const deliveredClaim = (id, extra = {}) => ({
  id, title: `Title ${id}`, state: "delivered", owner: "agent-1", kind: "task",
  files: [], dependsOn: [], tags: [], reviews: [], attestations: [],
  history: [{ action: "created" }, { action: "claimed" }, { action: "state:delivered" }],
  claimedAt: T0, deliveryGeneration: 1, claimRound: 1,
  delivery: { artifact: { kind: "report", ref: "https://example.com/r", sha256: SHA },
    checks: [{ name: "unit", result: "pass" }], criteria: [], digest: DIGEST, deliveredBy: "agent-1", deliveredAt: T0 },
  ...extra,
});

function installBoard(t, { memberId, claims }) {
  const dom = makeDom(t);
  const posts = [];
  const state = { room: { ownerId: "owner-x" }, members: MEMBERS, eventLog: [] };
  const live = { claims };
  const client = { generation: 1, path: path => path, request(path, options) {
    if (options?.method === "POST") { posts.push({ path, data: options.data }); return Promise.resolve({}); }
    if (path.startsWith("/work-claims?")) return Promise.resolve({ claims: live.claims });
    if (path === "/work-claims/status") return Promise.resolve({ behind: 0 });
    if (path === "/work-claims/config") return Promise.resolve({ maxMemberOpenClaims: 20 });
    throw new Error(`unexpected request: ${path}`);
  } };
  const board = installWorkBoard({ client, getState: () => state,
    getSession: () => ({ roomId: "commons", member: { id: memberId } }) });
  const settle = async () => { await board.whenReady(); await new Promise(resolve => setImmediate(resolve)); };
  const backgroundRepaint = async () => {
    state.eventLog.push({ type: "work_claim.updated", id: `bg-${state.eventLog.length}` });
    board.sync();
    await settle();
  };
  return { dom, board, posts, live, settle, backgroundRepaint };
}

// ---------------------------------------------------------------- D5 -----

test("D5: clicking Send back fires the update POST through the real delegated listener", async t => {
  const claim = deliveredClaim("wc_sb");
  const { dom, posts, live, settle } = installBoard(t, { memberId: "agent-1", claims: [claim] });
  await settle();
  const button = dom.query('[data-claim-action="sendback"]');
  assert.ok(button, "the delivered claim offers the owner a Send back control");
  live.claims = [{ ...claim, state: "in_progress", verification: { by: "agent-1", state: "sent_back", at: T0 } }];
  dom.fire("click", button);
  await settle();
  assert.equal(posts.length, 1, "exactly one mutation POST");
  assert.equal(posts[0].path, "/work-claims/wc_sb/update");
  assert.equal(posts[0].data.state, "in_progress");
  assert.match(posts[0].data.requestId, /^sendback-wc_sb-1-[0-9a-f]{16}-agent-1$/,
    "the POST carries the round-bound send-back operation identity");
  assert.equal(posts[0].data.expectedClaimedAt, T0);
  assert.equal(dom.query('[data-claim-action="sendback"]'), null, "the control is gone once the claim is back in progress");
});

// ---------------------------------------------------------------- D4 -----

test("D4: a background repaint preserves the review draft and the selected verdict", async t => {
  const claim = deliveredClaim("wc_r1");
  const { dom, settle, backgroundRepaint } = installBoard(t, { memberId: "rev-1", claims: [claim] });
  await settle();
  const form = () => dom.query('form[data-claim-review="wc_r1"]');
  assert.ok(form(), "the reviewer gets the review form");
  const summary = form().querySelector('[name="summary"]');
  const verdict = form().querySelector('[name="verdict"]');
  summary.value = "Second case still fails on empty input";
  verdict.value = "changes_requested";
  dom.fire("input", summary);
  dom.fire("input", verdict);
  await backgroundRepaint();
  assert.ok(form(), "the review form still renders after the repaint");
  assert.equal(form().querySelector('[name="summary"]').value, "Second case still fails on empty input",
    "the unsent summary survives the background repaint");
  assert.equal(form().querySelector('[name="verdict"]').value, "changes_requested",
    "the selected verdict survives the background repaint");
});

test("D4: a background repaint preserves a delivery draft", async t => {
  const claim = { id: "wc_d1", title: "Title wc_d1", state: "in_progress", owner: "agent-1", kind: "task",
    files: [], dependsOn: [], tags: [], reviews: [], attestations: [],
    history: [{ action: "created" }, { action: "claimed" }], claimedAt: T0, deliveryGeneration: 0,
    acceptanceCriteria: ["case A handled"], delivery: null };
  const { dom, settle, backgroundRepaint } = installBoard(t, { memberId: "agent-1", claims: [claim] });
  await settle();
  const form = () => dom.query('form[data-claim-deliver="wc_d1"]');
  assert.ok(form(), "the holder gets the deliver form");
  const ref = form().querySelector('[name="artifactRef"]');
  const check = form().querySelector('[name="checkName"]');
  ref.value = "https://example.com/build/42";
  check.value = "unit tests";
  dom.fire("input", ref);
  dom.fire("input", check);
  await backgroundRepaint();
  assert.ok(form(), "the deliver form still renders after the repaint");
  assert.equal(form().querySelector('[name="artifactRef"]').value, "https://example.com/build/42",
    "the unsent artifact ref survives the background repaint");
  assert.equal(form().querySelector('[name="checkName"]').value, "unit tests",
    "the unsent check name survives the background repaint");
});

test("D4: a background repaint preserves the new-item draft", async t => {
  const claim = deliveredClaim("wc_n1");
  const { dom, settle, backgroundRepaint } = installBoard(t, { memberId: "rev-1", claims: [claim] });
  await settle();
  const form = () => dom.query("#board-new-item");
  assert.ok(form(), "a writer gets the new-item form");
  const title = form().querySelector('[name="title"]');
  const note = form().querySelector('[name="note"]');
  title.value = "Write the runbook";
  note.value = "Cover the restore drill";
  dom.fire("input", title);
  dom.fire("input", note);
  await backgroundRepaint();
  assert.equal(form().querySelector('[name="title"]').value, "Write the runbook",
    "the unsent title survives the background repaint");
  assert.equal(form().querySelector('[name="note"]').value, "Cover the restore drill",
    "the unsent note survives the background repaint");
});
