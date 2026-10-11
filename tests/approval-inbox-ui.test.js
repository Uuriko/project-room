// Unit tests for src/approval-inbox.js (WAVE-500 guild 10, worker 16/50):
// the unified approval-inbox web UI. Pure helpers (normalization, sorting,
// filtering, HTML rendering) plus the wired UI behavior against a stub
// fetcher and a minimal fake container. No DOM, no network.
import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml, normalizeCard, sortPending, kindsOf, filterByKind, isResolved,
  cardListHtml, cardDetailHtml, emptyStateHtml, inboxHtml, createApprovalInbox,
} from "../src/approval-inbox.js";

const card = (over = {}) => normalizeCard({
  id: "a1", kind: "spend", title: "Buy 500 connects", what: "Spend $30 on Upwork Connects.",
  context: "Requested for the buyer pipeline.", options: [
    { label: "Buy now", consequence: "$30 leaves the balance immediately." },
    { label: "Wait", consequence: "Pipeline stays paused until funded." },
  ],
  requestedBy: "quill", createdAt: "2026-10-10T19:00:00Z", expiresAt: "2026-10-11T19:00:00Z",
  status: "pending", ...over,
});

test("normalizeCard keeps the design card shape and rejects junk", () => {
  const c = card();
  assert.equal(c.id, "a1");
  assert.equal(c.kind, "spend");
  assert.equal(c.options.length, 2);
  assert.equal(c.options[0].consequence, "$30 leaves the balance immediately.");
  assert.equal(c.status, "pending");
  assert.equal(normalizeCard(null), null);
  assert.equal(normalizeCard({}), null);
  assert.equal(normalizeCard({ id: "x" }).status, "pending");
  assert.equal(normalizeCard({ id: "x", options: "nope" }).options.length, 0);
});

test("escapeHtml neutralizes markup in rendered fields", () => {
  const html = cardListHtml([card({ title: "<script>alert(1)</script>" })]);
  assert.equal(html.includes("<script>"), false);
  assert.ok(html.includes("&lt;script&gt;"));
});

test("sortPending orders oldest first, dateless last, stable by id", () => {
  const a = card({ id: "a", createdAt: "2026-10-10T20:00:00Z" });
  const b = card({ id: "b", createdAt: "2026-10-10T19:00:00Z" });
  const c = card({ id: "c", createdAt: "" });
  const sorted = sortPending([a, c, b]);
  assert.deepEqual(sorted.map(x => x.id), ["b", "a", "c"]);
});

test("kindsOf and filterByKind drive the kind filter", () => {
  const cards = [card({ id: "1", kind: "spend" }), card({ id: "2", kind: "deploy" }), card({ id: "3", kind: "spend" })];
  assert.deepEqual(kindsOf(cards), ["deploy", "spend"]);
  assert.equal(filterByKind(cards, "all").length, 3);
  assert.deepEqual(filterByKind(cards, "spend").map(x => x.id), ["1", "3"]);
});

test("isResolved treats only pending as undecided", () => {
  assert.equal(isResolved(card()), false);
  assert.equal(isResolved(card({ status: "approved" })), true);
  assert.equal(isResolved(card({ status: "deny-stop" })), true);
});

test("cardDetailHtml shows what-changes, per-option consequences, and three real decide buttons", () => {
  const html = cardDetailHtml(card());
  assert.ok(html.includes("What changes"));
  assert.ok(html.includes("Spend $30 on Upwork Connects."));
  assert.ok(html.includes("$30 leaves the balance immediately."));
  assert.ok(html.includes("Buy now"));
  const buttons = [...html.matchAll(/<button[^>]*data-inbox-decide="([^"]+)"[^>]*>/g)].map(m => m[1]);
  assert.deepEqual(buttons, ["approve", "approve-session", "deny-stop"]);
  for (const m of html.matchAll(/<button[^>]*>/g)) assert.ok(m[0].includes('type="button"'));
});

test("cardDetailHtml hides decide buttons on resolved cards and shows the receipt link", () => {
  const html = cardDetailHtml(card({ status: "approved", receiptId: "r-9", receiptUrl: "/api/rooms/x/receipts/r-9" }));
  assert.equal(html.includes("data-inbox-decide"), false);
  assert.ok(html.includes("Receipt"));
  assert.ok(html.includes("/api/rooms/x/receipts/r-9"));
});

test("cardDetailHtml never renders a javascript: receipt URL", () => {
  const html = cardDetailHtml(card({ status: "approved", receiptUrl: "javascript:alert(1)" }));
  assert.equal(html.includes("javascript:"), false);
});

test("emptyStateHtml is honest: no placeholder content, ever", () => {
  assert.ok(emptyStateHtml("empty").includes("No pending decisions."));
  assert.ok(emptyStateHtml("unavailable").includes("isn’t available"));
  assert.ok(emptyStateHtml("error").includes("Couldn't load"));
  assert.ok(emptyStateHtml("loading").includes("Loading"));
  for (const reason of ["empty", "unavailable", "error", "loading"]) {
    assert.equal(emptyStateHtml(reason).includes("lorem"), false);
  }
});

test("inboxHtml renders the filter, list oldest-first, and the human-only note", () => {
  const cards = sortPending([card({ id: "a", kind: "spend", createdAt: "2026-10-10T20:00:00Z", title: "Newer" }),
    card({ id: "b", kind: "deploy", createdAt: "2026-10-10T19:00:00Z", title: "Older" })]);
  const html = inboxHtml({ cards, kind: "all", selectedId: null, phase: "ready", error: "" });
  assert.ok(html.indexOf("Older") < html.indexOf("Newer"));
  assert.ok(html.includes("Only humans can decide"));
  assert.ok(html.includes('data-inbox-kind="spend"'));
  assert.ok(html.includes('data-inbox-kind="deploy"'));
});

// --- Wired behavior: stub fetcher + fake container, no DOM, no network. ---

function fakeContainer() {
  const listeners = {};
  return {
    innerHTML: "",
    listeners,
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    dispatch(type, dataset) {
      const target = { dataset, closest(sel) {
        const m = /^\[data-inbox-([a-z]+)(?:="([^"]*)")?\]$/.exec(sel);
        if (!m) return null;
        const key = "inbox" + m[1][0].toUpperCase() + m[1].slice(1);
        if (!(key in dataset)) return null;
        if (m[2] !== undefined && dataset[key] !== m[2]) return null;
        return { dataset };
      } };
      for (const fn of listeners[type] ?? []) fn({ target, preventDefault() {} });
    },
  };
}

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok, status, json: async () => body,
});

test("createApprovalInbox refresh renders pending cards oldest-first", async () => {
  const calls = [];
  const fetcher = async (url, opts = {}) => { calls.push([url, opts.method ?? "GET"]); return jsonResponse({ approvals: [
    { ...card({ id: "a", createdAt: "2026-10-10T20:00:00Z", title: "Newer" }), status: "pending" },
    { ...card({ id: "b", createdAt: "2026-10-10T19:00:00Z", title: "Older" }), status: "pending" },
  ] }); };
  const container = fakeContainer();
  const inbox = createApprovalInbox({ fetcher, container, roomId: "muse-room" });
  await inbox.refresh();
  assert.ok(calls[0][0].includes("/api/rooms/muse-room/approvals"));
  assert.ok(container.innerHTML.indexOf("Older") < container.innerHTML.indexOf("Newer"));
});

test("createApprovalInbox degrades gracefully when the API is absent", async () => {
  const fetcher = async () => jsonResponse({ error: "nope" }, { ok: false, status: 404 });
  const container = fakeContainer();
  const inbox = createApprovalInbox({ fetcher, container, roomId: "muse-room" });
  await inbox.refresh();
  assert.ok(container.innerHTML.includes("isn’t available"));
  assert.equal(inbox.state.phase, "unavailable");
});

test("createApprovalInbox surfaces fetch errors with a retry, never a crash", async () => {
  const fetcher = async () => { throw new Error("boom"); };
  const container = fakeContainer();
  const inbox = createApprovalInbox({ fetcher, container, roomId: "muse-room" });
  await inbox.refresh();
  assert.ok(container.innerHTML.includes("Couldn't load"));
  assert.ok(container.innerHTML.includes("data-inbox-retry"));
  assert.equal(inbox.state.phase, "error");
});

test("decide posts the decision and shows the receipt link", async () => {
  const posts = [];
  const fetcher = async (url, opts = {}) => {
    if ((opts.method ?? "GET") === "POST") { posts.push([url, JSON.parse(opts.body)]); return jsonResponse({ approval: { ...card({ status: "approved" }), status: "approved" }, receipt: { id: "r-1", url: "/r/r-1" } }); }
    return jsonResponse({ approvals: [{ ...card(), status: "pending" }] });
  };
  const container = fakeContainer();
  const inbox = createApprovalInbox({ fetcher, container, roomId: "muse-room" });
  await inbox.refresh();
  container.dispatch("click", { inboxOpen: "a1" });
  assert.ok(container.innerHTML.includes("What changes"));
  container.dispatch("click", { inboxDecide: "deny-stop", inboxId: "a1" });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(posts.length, 1);
  assert.ok(posts[0][0].endsWith("/api/rooms/muse-room/approvals/a1/decide"));
  assert.deepEqual(posts[0][1], { decision: "deny-stop" });
  assert.ok(container.innerHTML.includes("/r/r-1"));
  assert.equal(container.innerHTML.includes("data-inbox-decide"), false);
});

test("kind filter buttons narrow the list", async () => {
  const fetcher = async () => jsonResponse({ approvals: [
    { ...card({ id: "1", kind: "spend", title: "Spend one" }), status: "pending" },
    { ...card({ id: "2", kind: "deploy", title: "Deploy two" }), status: "pending" },
  ] });
  const container = fakeContainer();
  const inbox = createApprovalInbox({ fetcher, container, roomId: "muse-room" });
  await inbox.refresh();
  container.dispatch("click", { inboxKind: "deploy" });
  assert.ok(container.innerHTML.includes("Deploy two"));
  assert.equal(container.innerHTML.includes("Spend one"), false);
});
