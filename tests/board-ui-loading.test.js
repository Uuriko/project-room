// Board loading states (BU-02): every async board surface shows an honest
// loading state. Fail-first: these imports/assertions fail on the pre-fix
// board-ui.js, which renders a lying empty-board copy while loading and gives
// action buttons zero in-flight feedback.
import test from "node:test";
import assert from "node:assert/strict";
import { boardHtml, boardSkeletonHtml, pendingOutcome } from "../src/board-ui.js";

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
