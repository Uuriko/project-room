// #3754 client half: a board_review attention item renders with its own kind
// label and the Review anchor into the claim's record (#3795's path), like
// every other GET-action attention item. Harness mirrors
// tests/needs-attention-retry.test.js (fake section + fake client).
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
    hidden: true,
    querySelector: sel => elements[sel] ?? stubElement(),
    _elements: elements,
  };
}

test("a board_review item renders its label and a Review anchor to the claim record", async () => {
  const section = makeSection();
  const client = {
    session: { id: "sess-1" },
    generation: 1,
    needsAttention: async () => ({
      items: [{
        kind: "board_review", id: "wc_9", severity: "action",
        title: "Review: Claim wc_9",
        detail: "Delivered work is waiting for your review.",
        actions: [{ action: "review", method: "GET", path: "/api/rooms/commons/work-claims/wc_9" }],
      }],
      itemCount: 1, pageOffset: 0,
    }),
  };
  const card = createNeedsAttentionCard({ client, section });
  const prevDocument = globalThis.document;
  globalThis.document = { activeElement: null };
  try {
    await card.refresh();
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
  const html = section._elements["#attention-list"].innerHTML;
  assert.match(html, /Board review/, "the kind has a human label, not the raw kind string");
  assert.match(html, /href="#pr-record\/work\/wc_9"/, "the Review anchor targets the claim's record route");
  assert.match(html, /data-open-work="wc_9"/, "the anchor rides the shared open-work dispatch");
});
