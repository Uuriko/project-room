// F4A (MEASURE-IMPROVE): F-U1A3-1 — per-item action controls must carry the
// item's identity in their accessible names. Before this fix the board card
// buttons, the needs-me row buttons and the needs-attention decide buttons
// were bare verbs ("Claim", "Renew", "Approve", …) repeated per item, and
// every message's overflow summary read the identical "More actions for
// this message". The cure pattern already existed in board-ui.js (the
// link-PR input's "Pull request URL for ${item.title}").
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boardHtml } from "../src/board-ui.js";
import { needsMeHtml } from "../src/board-mine.js";
import { createNeedsAttentionCard } from "../src/needs-attention.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const iso = ms => new Date(ms).toISOString();

test("board cards: two Claim buttons on different items have distinct accessible names containing their titles", () => {
  const members = { "viewer-1": { id: "viewer-1", kind: "human", active: true, permissions: ["accept_work"] } };
  const viewer = { id: "viewer-1", manage: false, owner: false, write: true };
  const item = (id, title) => ({ id, title, state: "unclaimed", owner: null, kind: "task", files: [], dependsOn: [], tags: [], reviews: [], attestations: [], history: [] });
  const html = boardHtml([item("wc_a", "Fix the roof"), item("wc_b", "Paint the door")], null, viewer, members, NOW, {});
  const labels = [...html.matchAll(/data-claim-action="claim"[^>]*aria-label="([^"]*)"/g)].map(m => m[1]);
  assert.equal(labels.length, 2, "both unclaimed cards render a Claim button");
  assert.notEqual(labels[0], labels[1], "accessible names are distinguishable");
  assert.ok(labels[0].includes("Fix the roof"), `first name carries its item title: ${labels[0]}`);
  assert.ok(labels[1].includes("Paint the door"), `second name carries its item title: ${labels[1]}`);
});

test("needs-me rows: two Renew buttons on different items have distinct accessible names containing their titles", () => {
  const me = "ai_me";
  const members = { [me]: { id: me, displayName: "Codex QA", kind: "agent" } };
  const claim = (id, title) => ({ id, title, state: "claimed", owner: me, tags: [], reviews: [], updatedAt: iso(NOW - 5 * 60000), leaseExpiresAt: iso(NOW + 20 * 60000) });
  const html = needsMeHtml([claim("wc_a", "Fix the roof"), claim("wc_b", "Paint the door")], { id: me, write: true }, members, NOW);
  const labels = [...html.matchAll(/data-claim-action="renew"[^>]*aria-label="([^"]*)"/g)].map(m => m[1]);
  assert.equal(labels.length, 2, "both expiring claims render a Renew button");
  assert.notEqual(labels[0], labels[1], "accessible names are distinguishable");
  assert.ok(labels[0].includes("Fix the roof"), `first name carries its item title: ${labels[0]}`);
  assert.ok(labels[1].includes("Paint the door"), `second name carries its item title: ${labels[1]}`);
});

function stubElement() {
  return {
    hidden: false, disabled: false, innerHTML: "", textContent: "", dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {}, addEventListener() {}, querySelectorAll: () => [], closest: () => null, focus() {},
  };
}

test("needs-attention: Approve/Deny buttons carry the item's title in their accessible names", async t => {
  const elements = {
    "#attention-list": stubElement(), "#attention-count": stubElement(), "#attention-status": stubElement(),
    "#attention-refresh": stubElement(), "#attention-pages": stubElement(), "#attention-range": stubElement(),
    "#attention-previous": stubElement(), "#attention-next": stubElement(),
  };
  const section = { hidden: true, querySelector: sel => elements[sel] ?? stubElement(), _elements: elements };
  const client = {
    session: { id: "sess-1" }, generation: 1,
    needsAttention: async () => ({
      items: [{
        kind: "access_request", id: "ar_1", severity: "action", requestKind: "permissions",
        title: "Sam asks to join", detail: "Wants in.",
        requestedPermissions: [],
        actions: [
          { action: "approve", method: "POST", body: { decision: "approve" } },
          { action: "deny", method: "POST", body: { decision: "deny" } },
        ],
      }],
      itemCount: 1, pageOffset: 0,
    }),
  };
  const card = createNeedsAttentionCard({ client, section });
  const prevDocument = globalThis.document;
  globalThis.document = { activeElement: null };
  t.after(() => { if (prevDocument === undefined) delete globalThis.document; else globalThis.document = prevDocument; });
  await card.refresh();
  const html = elements["#attention-list"].innerHTML;
  assert.match(html, /aria-label="Approve — Sam asks to join"/, "Approve names its item");
  assert.match(html, /aria-label="Decline — Sam asks to join"/, "Decline names its item");
});

test("timeline overflow: the message-more summary names the message (author identity), not a bare generic label", () => {
  // src/app.js is browser-wired and not unit-importable; the check is on the
  // rendered template's source shape — the summary's aria-label must be
  // built from the message's author identity, like the adjacent
  // "Link to message by … at …" label in messageContent.
  const appSource = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.ok(appSource.includes('uiText("message.actionsAccessibleName", { author: displayName(m.authorId)'), "summary uses the catalogued author/time name");
  assert.ok(!appSource.includes('aria-label="More actions for this message"'), "the identical-on-every-message label is gone");
});
