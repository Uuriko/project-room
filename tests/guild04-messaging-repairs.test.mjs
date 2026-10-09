// tests/guild04-messaging-repairs.test.mjs — GUILD-04 (Dot redirect 2026-10-09):
// delivery/readback/ack correlation, dedupe, bounded coordinator summaries,
// reusing the existing Room messaging (board-comment [lane][kind] grammar).
//
// ADDITIVE: exercises only server/agent-handoffs.mjs and scripts/handoff-lint.mjs;
// no server routes, no live calls, fixture-backed. Runnable: node --test this file.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  normalizeEvent, dedupeKey, ownerMatches, checkThreadParent,
  correlate, summarize,
} from "../server/agent-handoffs.mjs";
import {
  GOOD_ROUTE, BAD_EDIT_BEFORE_ACK, BAD_DUPLICATE_RECEIPT,
  BAD_ROUTE_NO_READBACK, BAD_THREAD_PARENT, OWNER_PROBE, PLAIN_CHATTER,
} from "./fixtures/guild04/events.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const withSeq = (arr) => arr.map((c, i) => { const e = normalizeEvent(c); e.seq = i; return e; });
const codes = (cor) => cor.violations.map((v) => v.code);

test("good route: delivery/readback/ack/receipt correlate with zero violations", () => {
  const cor = correlate(withSeq(GOOD_ROUTE));
  const r = cor.records.get("TASK-100");
  assert.ok(r, "task record exists");
  assert.equal(r.delivered, true, "route delivered: read-back confirmed the message id");
  assert.equal(r.acked, true, "owner acked");
  assert.equal(r.receipted, true, "owner receipted");
  assert.deepEqual(cor.violations, [], "no violations on the happy path");
});

test("negative control 1: edit before ack is flagged", () => {
  const cor = correlate(withSeq(BAD_EDIT_BEFORE_ACK));
  assert.ok(codes(cor).includes("EDIT_BEFORE_ACK"), `expected EDIT_BEFORE_ACK, got ${codes(cor)}`);
});

test("negative control 2: duplicate receipt by same lane is flagged (Q001 shape)", () => {
  const cor = correlate(withSeq(BAD_DUPLICATE_RECEIPT));
  const r = cor.records.get("TASK-300");
  assert.equal(r.duplicates, 1, "one duplicate counted");
  assert.ok(codes(cor).includes("DUPLICATE_RECEIPT"));
});

test("negative control 3: route without read-back is undelivered (submission != delivery)", () => {
  const cor = correlate(withSeq(BAD_ROUTE_NO_READBACK));
  const r = cor.records.get("TASK-400");
  assert.equal(r.delivered, false, "no read-back means not delivered");
  assert.ok(codes(cor).includes("ROUTE_WITHOUT_READBACK"));
});

test("negative control 4: thread parent must be the inbound, not the grandparent", () => {
  const ev = normalizeEvent(BAD_THREAD_PARENT[1]);
  const t = checkThreadParent(ev, BAD_THREAD_PARENT[1].thread_inbound_id);
  assert.equal(t.ok, false, "grandparent parent_id must fail");
  assert.equal(t.expected, "t1");
  assert.equal(t.got, "t0-grandparent");
  const good = normalizeEvent({ ...BAD_THREAD_PARENT[1], parent_id: "t1" });
  assert.equal(checkThreadParent(good, "t1").ok, true, "inbound parent_id passes");
});

test("author-id trap: ownership resolves by username only", () => {
  const ev = normalizeEvent(OWNER_PROBE[0]);
  assert.equal(ownerMatches(ev, "jill"), true, "username match is the ownership test");
  assert.equal(ownerMatches(ev, "quill"), false);
  // The venue author.id form (probe_sub) does NOT equal the event's jwt_sub —
  // a filter on either id form would miss or mismatch; username is the key.
  assert.notEqual(ev.jwt_sub, OWNER_PROBE[0].probe_sub, "id forms disagree by design");
});

test("plain chatter without lane grammar parses to null — never a phantom handoff", () => {
  for (const c of PLAIN_CHATTER) assert.equal(normalizeEvent(c), null);
});

test("dedupeKey: same task+lane+kind collapses; different lanes do not", () => {
  const a = normalizeEvent(BAD_DUPLICATE_RECEIPT[0]);
  const b = normalizeEvent(BAD_DUPLICATE_RECEIPT[1]);
  assert.equal(dedupeKey(a), dedupeKey(b), "duplicate receipts share a key");
  const other = normalizeEvent({ ...BAD_DUPLICATE_RECEIPT[0], body: "[fo][receipt] TASK-300 done." });
  assert.notEqual(dedupeKey(a), dedupeKey(other), "different lane, different key");
});

test("coordinator summary is bounded: one rollup, hard line cap", () => {
  const all = withSeq([...BAD_EDIT_BEFORE_ACK, ...BAD_DUPLICATE_RECEIPT, ...BAD_ROUTE_NO_READBACK, ...BAD_THREAD_PARENT]);
  const cor = correlate(all);
  const out = summarize(cor, { maxLines: 10 });
  assert.ok(out.split("\n").length <= 10, "never more than maxLines");
  assert.ok(out.includes("violations:"), "rollup carries counts, not the event bodies");
});

test("handoff-lint CLI: exit 0 on the good fixture via stdin", () => {
  const out = execFileSync("node", [join(ROOT, "scripts/handoff-lint.mjs")], {
    input: JSON.stringify(GOOD_ROUTE), encoding: "utf8",
  });
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.violations, []);
});

test("handoff-lint CLI: exit 2 on bad fixtures (negative control through the script)", () => {
  for (const [name, fx] of Object.entries({ BAD_EDIT_BEFORE_ACK, BAD_DUPLICATE_RECEIPT, BAD_ROUTE_NO_READBACK })) {
    let code = null;
    try {
      execFileSync("node", [join(ROOT, "scripts/handoff-lint.mjs")], { input: JSON.stringify(fx), encoding: "utf8" });
    } catch (e) { code = e.status; }
    assert.equal(code, 2, `${name}: lint must exit 2, got ${code}`);
  }
});
