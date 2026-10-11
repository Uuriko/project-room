// Fail-first tests for server/approval-inbox-digest.mjs — the unified approval
// inbox digest that REPLACES the evening tap-list digest. The digest is
// generated from live inbox state (cards), never hand-edited markdown.
import test from "node:test";
import assert from "node:assert/strict";
import { renderDigest } from "../server/approval-inbox-digest.mjs";

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
// Fixed clock: Sat 2026-10-10 12:00:00 UTC — every age/expiry is pinned.
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

const card = (over = {}) => ({
  id: "t1",
  kind: "Money",
  title: "Receipt Challenge prizes",
  createdAtMs: NOW - 3 * DAY,
  expiresAtMs: null,
  options: ["$1,500 pool", "$750 lean"],
  ref: "https://room.example/inbox?t=1",
  ...over,
});

const mdOf = (cards, opts = {}) => renderDigest(cards, { now: NOW, ...opts });

// --- shape: pure function, markdown string ------------------------------------
test("returns a markdown string and is pure (same input, same output)", () => {
  const cards = [card()];
  const a = mdOf(cards);
  const b = mdOf(cards);
  assert.equal(typeof a, "string");
  assert.equal(a, b);
  assert.ok(a.startsWith("# "), "starts with a markdown heading");
});

// --- sections: grouping by kind, fixed order --------------------------------
test("groups cards under Money/Identity/Deploys/Permissions/Publish/Other, in that order", () => {
  const cards = [
    card({ id: "p1", kind: "Publish", title: "Publish queue" }),
    card({ id: "o1", kind: "Weird", title: "Unknown kind" }),
    card({ id: "m1", kind: "Money", title: "Money item" }),
    card({ id: "i1", kind: "Identity", title: "Sign-in session" }),
    card({ id: "d1", kind: "Deploys", title: "Redeploy" }),
    card({ id: "pm1", kind: "Permissions", title: "Grant access" }),
  ];
  const md = mdOf(cards);
  const sections = ["## Money", "## Identity", "## Deploys", "## Permissions", "## Publish", "## Other"];
  const idx = sections.map(s => md.indexOf(s));
  assert.ok(idx.every(i => i >= 0), "all six sections present:\n" + md);
  assert.ok(idx.every((v, i, a) => i === 0 || a[i - 1] < v), "sections in fixed order");
  assert.ok(md.includes("Unknown kind"), "unknown kind lands in Other");
});

test("omits kinds with no cards", () => {
  const md = mdOf([card({ kind: "Money" })]);
  assert.ok(!md.includes("## Identity"), "empty Identity section omitted");
});

// --- card lines: [kind] title — age — options summary — link ref ------------
test("each card renders as one line: [kind] title — age — options — link ref", () => {
  const md = mdOf([card()]);
  const line = md.split("\n").find(l => l.includes("Receipt Challenge prizes"));
  assert.ok(line, "card line present");
  assert.match(line, /^\s*-\s*\[money\]/, "line starts with [kind] badge");
  assert.ok(line.includes("3d"), "age shown");
  assert.ok(line.includes("$1,500 pool / $750 lean"), "options joined with /");
  assert.ok(line.includes("https://room.example/inbox?t=1"), "link ref present");
  assert.ok(!line.includes("\n"), "single line");
});

test("card titles with newlines are sanitized to one line", () => {
  const md = mdOf([card({ title: "line one\nline two" })]);
  const lines = md.split("\n").filter(l => l.includes("line one"));
  assert.equal(lines.length, 1, "exactly one line mentions the card");
  assert.ok(lines[0].includes("line two"), "the rest of the title stays on the same line");
});

test("card without ref falls back to the kind's card-list query", () => {
  const md = mdOf([card({ ref: undefined, id: "t9" })]);
  const line = md.split("\n").find(l => l.includes("Receipt Challenge prizes"));
  assert.ok(line.includes("t9"), "card id still traceable");
});

// --- header: total pending, oldest unhandled, expiring <24h -----------------
test("header carries total pending, oldest unhandled, and expiring <24h", () => {
  const cards = [
    card({ id: "a", createdAtMs: NOW - 6 * DAY }),
    card({ id: "b", createdAtMs: NOW - 2 * DAY, expiresAtMs: NOW + 5 * HOUR }),
    card({ id: "c", createdAtMs: NOW - 1 * DAY }),
  ];
  const md = mdOf(cards);
  const header = md.split("\n").slice(0, 6).join("\n");
  assert.ok(header.includes("3 pending"), "total pending:\n" + header);
  assert.ok(header.includes("6d"), "oldest unhandled age:\n" + header);
  assert.ok(header.includes("1 expiring <24h"), "expiring <24h:\n" + header);
});

test("overdue cards count toward the expiring-soon bucket and are marked", () => {
  const md = mdOf([card({ expiresAtMs: NOW - 2 * HOUR })]);
  const header = md.split("\n").slice(0, 6).join("\n");
  assert.ok(header.includes("1 expiring <24h"), "overdue card counted");
  assert.ok(/overdue/i.test(md), "overdue card marked on its line");
});

// --- traceability: every count links to a card-list query --------------------
test("every count links to a card-list query", () => {
  const cards = [
    card({ id: "a", kind: "Money" }),
    card({ id: "b", kind: "Identity", expiresAtMs: NOW + 5 * HOUR }),
  ];
  const md = mdOf(cards, { queryFor: q => `/inbox?q=${q}` });
  // total, per-section, and expiring counts are all markdown links
  assert.match(md, /\[2 pending\]\(\/inbox\?q=pending\)/, "total links to the pending query");
  assert.match(md, /\[1\]\(\/inbox\?q=money\)/, "Money count links to the money query");
  assert.match(md, /\[1\]\(\/inbox\?q=identity\)/, "Identity count links to the identity query");
  assert.match(md, /\[1 expiring <24h\]\(\/inbox\?q=expiring\)/, "expiring count links to the expiring query");
});

test("counts match the actual rows rendered", () => {
  const cards = [
    card({ id: "a", kind: "Money" }),
    card({ id: "b", kind: "Money" }),
    card({ id: "c", kind: "Deploys" }),
  ];
  const md = mdOf(cards);
  const cardLines = md.split("\n").filter(l => /^-\s*\[/.test(l.trim()));
  assert.equal(cardLines.length, 3, "one line per card");
  assert.match(md, /3 pending/, "header total matches rows");
});

// --- footer ------------------------------------------------------------------
test("footer is the exact required sentence", () => {
  const md = mdOf([card()]);
  assert.ok(
    md.includes("Generated from the approval inbox; reply with a card id to decide."),
    "footer present:\n" + md.slice(-200),
  );
});

// --- empty state: honest, not a placeholder ----------------------------------
test("empty inbox is honest: 'no pending decisions', zero counts, no sections", () => {
  const md = mdOf([]);
  assert.ok(md.includes("no pending decisions"), "says no pending decisions:\n" + md);
  assert.ok(md.includes("0 pending"), "zero total");
  assert.ok(!md.includes("## Money"), "no section headers");
  assert.ok(md.includes("Generated from the approval inbox; reply with a card id to decide."), "footer still present");
});

// --- forDate -----------------------------------------------------------------
test("forDate sets the digest date in the title", () => {
  const md = mdOf([card()], { forDate: new Date(Date.UTC(2026, 9, 11)) });
  assert.ok(md.startsWith("# Approval inbox digest — 2026-10-11"), "title date:\n" + md.split("\n")[0]);
});

// --- robustness ---------------------------------------------------------------
test("tolerates missing fields without throwing", () => {
  const md = mdOf([{ id: "x" }, null, undefined, { kind: "Money", options: "not-an-array" }]);
  assert.ok(typeof md === "string");
  assert.ok(md.includes("no pending decisions") || md.includes("pending"));
});
