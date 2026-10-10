// BU-12 — optimistic updates / UI-API consistency on the work-claims board.
//
// The board never paints item state optimistically: every mutation goes
// through act(), which announces success only after the API call resolves
// and then re-reads the list. This file pins the honest behaviors and holds
// one fail-first regression test for the case the read-after-write fails:
//
//   mutation OK + confirming refresh FAILED  =>  the status line must NOT
//   show the bare success copy ("Claimed 'x'") next to stale cards and the
//   load-error block. The action landed (API truth) but the board is stale
//   (UI truth); the status must say both.
//
// Harness: installWorkBoard with a stub DOM (same pattern as
// tests/needs-attention-retry.test.js) and a scripted fake client.
//
// NOTE (2026-10-09, BU-12 respawn): src/board-ui.js is live-claimed by bu-06
// (claim-flow UI, claim.sh age < 6h) — first-claim-wins, so the fix itself is
// handed off as bu-12/act-refresh-honesty.patch for bu-06's PR. The regression
// test below is committed SKIPPED until the owning lane lands the fix; the two
// pinning tests are green on current code. bu-10/bu-13/bu-05 claims on this
// file have expired (claim.sh FREE as of 2026-10-09 ~03:35 PDT).
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkBoard } from "../src/board-ui.js";

const CLAIM = { id: "a1", title: "Write the notes", state: "unclaimed", owner: null, dependsOn: [] };

function stubElement() {
  return {
    disabled: false,
    innerHTML: "",
    textContent: "",
    dataset: {},
    setAttribute() {},
    removeAttribute() {},
    querySelector() { return null; },
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => true,
    addEventListener() {},
    focus() {},
    readOnly: false,
  };
}

// Minimal DOM: #work-board root plus the #board-status line that paint()/note()
// write into. innerHTML assignments are captured so tests can inspect them.
function makeRoot() {
  const listeners = {};
  const statusLine = stubElement();
  const root = {
    _html: "",
    _statusLine: statusLine,
    isConnected: true,
    set innerHTML(html) { this._html = String(html); },
    get innerHTML() { return this._html; },
    querySelector(sel) {
      if (sel === "#board-status") return statusLine;
      return null;
    },
    contains: () => true,
    addEventListener(type, fn) { listeners[type] = fn; },
    replaceChildren() { this._html = ""; },
  };
  return { root, listeners, statusLine };
}

// Fake client. `script` maps request prefixes to handlers; handlers may throw
// to simulate transport/API failures. claimsReads counts GET /work-claims
// list reads so tests can fail the read that follows a mutation.
function makeClient({ onMutation = async () => ({}), onClaimsRead = null, failClaimsReadAfter = Infinity } = {}) {
  let claimsReads = 0;
  const client = {
    generation: 1,
    path: p => p,
    _claimsReads: () => claimsReads,
    async request(path, { method = "GET" } = {}) {
      if (path.startsWith("/work-claims?")) {
        claimsReads += 1;
        if (onClaimsRead) return onClaimsRead(claimsReads);
        if (claimsReads > failClaimsReadAfter) throw new Error("network down");
        return { claims: [{ ...CLAIM }], olderDone: 0 };
      }
      if (path === "/work-claims/status") return {};
      if (path === "/work-claims/config") return { maxMemberOpenClaims: 20 };
      if (method === "POST") return onMutation(path);
      throw new Error(`unexpected request ${method} ${path}`);
    },
  };
  return client;
}

const state = () => ({
  members: { u1: { id: "u1", kind: "human", active: true, displayName: "Uma", permissions: ["accept_work", "complete_work"] } },
  room: { ownerId: "owner1" },
  eventLog: [],
});
const session = () => ({ roomId: "r1", member: { id: "u1" } });

function stubGlobals() {
  const prevDocument = globalThis.document;
  const prevCSS = globalThis.CSS;
  globalThis.document = { activeElement: null };
  globalThis.CSS = { escape: s => String(s) };
  return () => {
    if (prevDocument === undefined) delete globalThis.document; else globalThis.document = prevDocument;
    if (prevCSS === undefined) delete globalThis.CSS; else globalThis.CSS = prevCSS;
  };
}

function claimButton() {
  return {
    dataset: { claimAction: "claim", claimId: "a1", focusKey: "claim:a1" },
    disabled: false,
    setAttribute() {},
    removeAttribute() {},
  };
}

function clickClaim(listeners) {
  const button = claimButton();
  listeners.click({ target: { closest: sel => (sel === "[data-claim-action]" ? button : null) } });
  return button;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 50));

async function mountBoard(client) {
  const { root, listeners, statusLine } = makeRoot();
  const restore = stubGlobals();
  const prevQuery = globalThis.document.querySelector;
  globalThis.document.querySelector = sel => (sel === "#work-board" ? root : null);
  const board = installWorkBoard({ client, getState: state, getSession: session });
  assert.equal(await board.whenReady(), true, "initial load succeeds");
  globalThis.document.querySelector = prevQuery;
  return { board, root, listeners, statusLine, restore };
}

// --- pinning: the failure path is honest (no false success) ---

test("failed claim (409) notes the server error and never shows success", async () => {
  const serverError = new Error("The claim changed since it was read");
  serverError.status = 409;
  serverError.code = "claim_changed";
  const client = makeClient({ onMutation: async () => { throw serverError; } });
  const { listeners, statusLine, root, restore } = await mountBoard(client);
  try {
    clickClaim(listeners);
    await settle();
    assert.equal(statusLine.textContent, "The claim changed since it was read");
    assert.ok(!statusLine.textContent.includes("Claimed '"), "no success copy on failure");
    assert.ok(root.innerHTML.includes('data-claim-action="claim"'), "stale card still offers Claim");
  } finally { restore(); }
});

test("successful claim + successful refresh shows success and the updated card", async () => {
  const client = makeClient({
    onClaimsRead: reads => (reads === 1
      ? { claims: [{ ...CLAIM }], olderDone: 0 }
      : { claims: [{ ...CLAIM, state: "claimed", owner: "u1" }], olderDone: 0 }),
  });
  const { listeners, statusLine, root, restore } = await mountBoard(client);
  try {
    const button = clickClaim(listeners);
    await settle();
    assert.equal(statusLine.textContent, "Claimed 'Write the notes'");
    assert.ok(!root.innerHTML.includes('data-claim-action="claim"'), "card no longer offers Claim");
    assert.equal(button.disabled, false, "button re-enabled after repaint removed it");
  } finally { restore(); }
});

// --- fail-first: success + failed confirming refresh must not claim success ---

test("successful claim + FAILED refresh does not show bare success copy (SKIPPED: fix owned by bu-06)", { skip: true }, async () => {
  const client = makeClient({ failClaimsReadAfter: 1 });
  const { listeners, statusLine, root, restore } = await mountBoard(client);
  try {
    clickClaim(listeners);
    await settle();
    // The claim landed server-side, but the board could not re-read: the
    // status must say BOTH, never the bare success copy next to stale cards.
    assert.ok(
      statusLine.textContent.includes("couldn't refresh"),
      `status must carry the refresh-failure caveat, got: ${JSON.stringify(statusLine.textContent)}`,
    );
    assert.ok(
      !/^Claimed 'Write the notes'$/.test(statusLine.textContent),
      "bare success copy next to stale cards is the bug",
    );
    assert.ok(root.innerHTML.includes("Could not load the board"), "error block still shown");
  } finally { restore(); }
});
