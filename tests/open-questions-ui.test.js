// Fail-first tests for src/open-questions-ui.js (audit wave-2 item 8):
// the open-questions radar panel, wired to GET /api/rooms/{roomId}/open-questions.
// Pure helpers (view model, date formatting, HTML rendering, escaping) plus the
// wired panel behavior against a stub client and a fake document.
// No real DOM, no network.
import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  formatQuestionWhen,
  openQuestionsModel,
  openQuestionsHtml,
  installOpenQuestionsPanel,
} from "../src/open-questions-ui.js";

const MOCK_RESPONSE = {
  roomId: "room1",
  viewerId: "m9",
  evaluatedAt: "2026-10-06T22:00:00.000Z",
  openQuestions: [
    { messageId: "m1", authorId: "a1", excerpt: "How do we ship this?", askedAt: "2026-10-06T21:00:00.000Z", threadRootId: "m1" },
    { messageId: "m2", authorId: "a2", excerpt: "Is the gateway up?", askedAt: "2026-10-06T21:30:00.000Z", threadRootId: "t2" },
  ],
};

test("openQuestionsModel normalizes a mocked endpoint response", () => {
  assert.deepEqual(openQuestionsModel(MOCK_RESPONSE), {
    count: 2,
    items: [
      { messageId: "m1", authorId: "a1", excerpt: "How do we ship this?", askedAt: "2026-10-06T21:00:00.000Z", when: "Oct 6", threadRootId: "m1" },
      { messageId: "m2", authorId: "a2", excerpt: "Is the gateway up?", askedAt: "2026-10-06T21:30:00.000Z", when: "Oct 6", threadRootId: "t2" },
    ],
  });
});

test("openQuestionsModel tolerates missing fields with safe defaults", () => {
  assert.deepEqual(openQuestionsModel(null), { count: 0, items: [] });
  assert.deepEqual(openQuestionsModel({}), { count: 0, items: [] });
  const model = openQuestionsModel({ openQuestions: [{}] });
  assert.equal(model.count, 1);
  assert.equal(model.items[0].messageId, "");
  assert.equal(model.items[0].authorId, "");
  assert.equal(model.items[0].excerpt, "");
  assert.equal(model.items[0].threadRootId, "");
  assert.equal(model.items[0].when, "");
});

test("escapeHtml neutralizes markup in excerpts", () => {
  assert.equal(escapeHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(42), "42");
});

test("formatQuestionWhen renders a short date or an honest blank", () => {
  assert.equal(formatQuestionWhen("2026-10-06T21:00:00.000Z"), "Oct 6");
  assert.equal(formatQuestionWhen(null), "");
  assert.equal(formatQuestionWhen("not-a-date"), "");
});

test("openQuestionsHtml renders the panel rows given a mocked endpoint response", () => {
  const html = openQuestionsHtml(openQuestionsModel(MOCK_RESPONSE));
  assert.ok(html.includes("How do we ship this?"), "renders the first excerpt");
  assert.ok(html.includes("Is the gateway up?"), "renders the second excerpt");
  assert.ok(html.includes("open-questions-list"), "renders the list element");
});

test("openQuestionsHtml escapes excerpts and is honest when empty", () => {
  const html = openQuestionsHtml(openQuestionsModel({
    openQuestions: [{ messageId: "m1", authorId: "a1", excerpt: "<img src=x>", askedAt: "2026-10-06T21:00:00.000Z", threadRootId: "m1" }],
  }));
  assert.ok(!html.includes("<img src=x>"), "raw markup must not appear");
  assert.ok(html.includes("&lt;img src=x&gt;"), "escaped markup appears instead");
  const empty = openQuestionsHtml(openQuestionsModel({ openQuestions: [] }));
  assert.ok(empty.includes("No open questions"), "empty state says so honestly");
});

test("installOpenQuestionsPanel without a panel never touches client or session", () => {
  const realDocument = globalThis.document;
  globalThis.document = { querySelector: () => null };
  try {
    const panel = installOpenQuestionsPanel({
      client: { request() { throw new Error("must not fetch without a panel"); } },
      getSession() { throw new Error("must not read the session without a panel"); },
    });
    assert.doesNotThrow(() => { panel.sync(); panel.reset(); });
  } finally {
    if (realDocument === undefined) delete globalThis.document; else globalThis.document = realDocument;
  }
});

test("installOpenQuestionsPanel fetches the open-questions endpoint and renders rows", async () => {
  const realDocument = globalThis.document;
  let listHtml = null, countText = null;
  const requested = [];
  globalThis.document = {
    querySelector: selector => {
      if (selector === "#open-questions-panel") return { addEventListener() {}, open: true };
      if (selector === "#open-questions-list-host") return { set innerHTML(html) { listHtml = html; } };
      if (selector === "#open-questions-count") return { set textContent(t) { countText = t; } };
      if (selector === "#open-questions-status") return { set textContent(t) {} };
      return null;
    },
  };
  const client = {
    session: { roomId: "room1", member: { id: "m9" } },
    path(suffix) { return `/api/rooms/room1${suffix}`; },
    async request(path, options) { requested.push({ path, options }); return MOCK_RESPONSE; },
  };
  try {
    const panel = installOpenQuestionsPanel({ client, getSession: () => client.session });
    await panel.sync();
    assert.deepEqual(requested.map(r => r.path), ["/api/rooms/room1/open-questions"]);
    assert.ok(listHtml && listHtml.includes("How do we ship this?"), "mocked rows rendered into the list");
    assert.equal(countText, "2", "count chip shows the open-question count");
  } finally {
    if (realDocument === undefined) delete globalThis.document; else globalThis.document = realDocument;
  }
});
