import test from "node:test";
import assert from "node:assert/strict";
import { syncSidebarSections } from "../src/room-layout.js";

// Minimal document double: querySelector answers panel ids, nothing else.
// The logic under test is the hidden truth-table; the double only routes ids
// to configurable fake panels.
function installFakeDocument(panels) {
  const had = "document" in globalThis;
  const prev = globalThis.document;
  globalThis.document = { querySelector: id => panels[id] ?? null };
  return () => { if (had) globalThis.document = prev; else delete globalThis.document; };
}

function panel({ open = false, inSidebar = true } = {}) {
  return { hidden: false, open, closest: selector => (inSidebar && selector === "#room-sidebar" ? {} : null) };
}

const owner = { id: "owner", kind: "human" };
const twoHumans = { owner, guest: { id: "guest", kind: "human" } };
const writeWork = { a: { mode: "write" } };

test("panels in the sidebar hide only when their section is unused and closed", () => {
  const restore = installFakeDocument({
    "#land-queue-panel": panel(),
    "#referral-panel": panel(),
  });
  try {
    syncSidebarSections({ members: { owner }, workItems: {} });
    assert.equal(globalThis.document.querySelector("#land-queue-panel").hidden, true);
    assert.equal(globalThis.document.querySelector("#referral-panel").hidden, true);

    syncSidebarSections({ members: twoHumans, workItems: writeWork });
    assert.equal(globalThis.document.querySelector("#land-queue-panel").hidden, false);
    assert.equal(globalThis.document.querySelector("#referral-panel").hidden, false);
  } finally { restore(); }
});

test("an open panel stays visible so a live render never pulls it away mid-read", () => {
  const restore = installFakeDocument({
    "#land-queue-panel": panel({ open: true }),
    "#referral-panel": panel({ open: true }),
  });
  try {
    syncSidebarSections({ members: { owner }, workItems: {} });
    assert.equal(globalThis.document.querySelector("#land-queue-panel").hidden, false);
    assert.equal(globalThis.document.querySelector("#referral-panel").hidden, false);
  } finally { restore(); }
});

test("panels outside the room sidebar are never hidden", () => {
  const restore = installFakeDocument({
    "#land-queue-panel": panel({ inSidebar: false }),
    "#referral-panel": panel({ inSidebar: false }),
  });
  try {
    syncSidebarSections({ members: { owner }, workItems: {} });
    assert.equal(globalThis.document.querySelector("#land-queue-panel").hidden, false);
    assert.equal(globalThis.document.querySelector("#referral-panel").hidden, false);
  } finally { restore(); }
});

test("missing panels are skipped without throwing", () => {
  const restore = installFakeDocument({});
  try {
    assert.doesNotThrow(() => syncSidebarSections({ members: twoHumans, workItems: writeWork }));
    assert.doesNotThrow(() => syncSidebarSections(null));
  } finally { restore(); }
});
