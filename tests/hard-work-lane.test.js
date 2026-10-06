import { test } from "node:test";
import assert from "node:assert/strict";
import { isHard, laneView, nextFor, pairingOf, tierOf, workMix } from "../scripts/hard-work-lane.mjs";
import { main, parseArgs, rosterOf } from "../scripts/hard-work.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = Date.parse("2026-10-06T03:00:00.000Z");
const hoursAgo = hours => new Date(NOW - hours * 3600 * 1000).toISOString();
const roster = [
  { id: "ai_grok", handle: "Grok Bot" },
  { id: "ai_tab", handle: "John's Tab" },
  { id: "ai_fo", handle: "Fo" },
  { id: "ai_claude", handle: "Claude (Cowork)" },
  { id: "ai_codex", handle: "Codex" },
  { id: "ai_codexqa", handle: "Codex QA" }
];
const item = (id, fields = {}) => ({
  id, title: fields.title ?? id, state: fields.state ?? "unclaimed", owner: fields.owner ?? null,
  tags: fields.tags ?? [], reviewPolicy: "reviewPolicy" in fields ? fields.reviewPolicy : "distinct_member", reviewedBy: fields.reviewedBy ?? null,
  reviews: fields.reviews ?? [], dependsOn: fields.dependsOn ?? [], pullRequest: null,
  history: fields.history ?? [{ at: hoursAgo(fields.age ?? 1), agentId: "ai_fo", action: "created", note: fields.note ?? null }],
  updatedAt: fields.updatedAt ?? hoursAgo(fields.age ?? 1)
});

test("lane marker, tier and pairing come from tags, with the create note as fallback", () => {
  const tagged = item("a", { tags: ["hard", "H3", "build-ai_grok", "rev-ai_tab"] });
  assert.equal(isHard(tagged), true);
  assert.equal(tierOf(tagged), "H3");
  assert.deepEqual(pairingOf(tagged, roster), { builder: "ai_grok", builders: ["ai_grok"], reviewer: "ai_tab", source: "tags" });
  const legacy = item("b", { tags: ["hard-problem", "H2"], note: "Seed item. Author: Tab or Fo. Verifier: Grok Bot. Reviewer: John's Tab." });
  assert.equal(isHard(legacy), true);
  const pairing = pairingOf(legacy, roster);
  assert.equal(pairing.reviewer, "ai_tab");
  assert.deepEqual(pairing.builders, ["ai_fo"], "unknown handle 'Tab' is never guessed");
  assert.equal(pairingOf(item("c", { tags: ["hard"], note: "Suggested Author: Claude or Codex. Reviewer: Fo (30-min promise)." }), roster).builder, "ai_claude");
  assert.equal(tierOf(item("d", { title: "H1: small but real" })), "H1");
  assert.deepEqual(pairingOf(item("s", { tags: ["hard", "build-codexqa", "rev-johnstab"] }), roster),
    { builder: "ai_codexqa", builders: ["ai_codexqa"], reviewer: "ai_tab", source: "tags" }, "handle slugs stand in for long ids");
  assert.equal(isHard(item("e", { tags: ["ready", "qa7"] })), false);
});

test("laneView flags missing reviewers, owner-as-reviewer, self-close, stuck and reviewer overload", () => {
  const items = [
    item("h1", { tags: ["hard", "H2", "rev-ai_fo"], state: "claimed", owner: "ai_claude" }),
    item("h2", { tags: ["hard", "H2", "rev-ai_fo"], state: "in_progress", owner: "ai_codexqa" }),
    item("h6", { tags: ["hard", "H2", "rev-ai_fo"] }),
    item("h3", { tags: ["hard", "H3", "rev-ai_fo"], state: "in_progress", owner: "ai_grok", age: 20 }),
    item("h4", { tags: ["hard", "H1"], reviewPolicy: null }),
    item("h5", { tags: ["hard", "H2", "rev-ai_tab"], state: "claimed", owner: "ai_tab" }),
    item("easy", { tags: ["ready"] }),
    item("closed", { tags: ["hard", "H3", "rev-ai_fo"], state: "done", owner: "ai_tab" })
  ];
  const view = laneView(items, { now: NOW, roster });
  assert.deepEqual(view.open.map(row => row.id), ["h3", "h1", "h2", "h5", "h6", "h4"]);
  assert.deepEqual(view.byTier, { H3: 1, H2: 4, H1: 1, untiered: 0 });
  assert.deepEqual(view.reviewerLoad, { ai_fo: 3, ai_tab: 1 }, "only claimed work counts as load");
  assert.equal(view.reviewerNamed.ai_fo, 4);
  assert.ok(!view.open.find(row => row.id === "h6").flags.includes("reviewer-overloaded"), "an unclaimed suggestion is not flagged");
  assert.deepEqual(view.needsPair.sort(), ["h4", "h5"]);
  assert.deepEqual(view.stuck, ["h3"]);
  assert.deepEqual(view.overloadedReviewers, ["ai_fo"]);
  assert.ok(view.open.find(row => row.id === "h4").flags.includes("self-close-allowed"));
  assert.ok(view.open.find(row => row.id === "h1").flags.includes("reviewer-overloaded"));
});

test("workMix counts only real done items: builder, approving reviewer, easy streak", () => {
  const done = (id, owner, at, extra = {}) => item(id, { ...extra, state: "done", owner,
    history: [{ at: hoursAgo(at + 1), agentId: owner, action: "created", note: null }, { at: hoursAgo(at), agentId: owner, action: "state:done", note: null }] });
  const items = [
    done("e1", "ai_grok", 50), done("e2", "ai_grok", 40),
    done("hard1", "ai_grok", 30, { tags: ["hard", "H2"], reviews: [{ memberId: "ai_tab", verdict: "approve" }, { memberId: "ai_fo", verdict: "comment" }] }),
    done("e3", "ai_grok", 20), done("e4", "ai_tab", 10),
    done("old", "ai_fo", 24 * 30),
    item("open-hard", { tags: ["hard", "H3"] })
  ];
  const mix = workMix(items, { since: NOW - 7 * 24 * 3600 * 1000, until: NOW });
  assert.deepEqual({ ...mix.ai_grok, lastHardAt: undefined }, { hardBuilt: 1, hardReviewed: 0, otherClosed: 3, easySinceHard: 1, lastHardAt: undefined });
  assert.equal(mix.ai_tab.hardReviewed, 1);
  assert.equal(mix.ai_tab.easySinceHard, 1);
  assert.equal(mix.ai_fo, undefined, "a comment is not a review credit; old work is outside the window");
});

test("nextFor prefers items naming the member, skips reserved and blocked-by-deps items, and picks a partner", () => {
  const items = [
    item("mine", { tags: ["hard", "H2", "build-ai_grok", "rev-ai_tab"] }),
    item("reserved", { tags: ["hard", "H3", "build-ai_claude", "rev-ai_fo"] }),
    item("waiting", { tags: ["hard", "H3", "rev-ai_fo"], dependsOn: ["design-doc"] }),
    item("design-doc", { tags: ["design"] }),
    item("open", { tags: ["hard", "H1"] })
  ];
  assert.deepEqual(nextFor(items, "ai_grok", { now: NOW, roster }), {
    id: "mine", title: "mine", tier: "H2", partner: "ai_tab", partnerSource: "named", reason: "names you as builder; tier H2"
  });
  const forFo = nextFor(items, "ai_fo", { now: NOW, roster, reviewers: ["ai_fo", "ai_codexqa", "ai_tab"] });
  assert.equal(forFo.id, "open", "the reserved H3 and the dependency-gated H3 are skipped");
  assert.equal(forFo.partner, "ai_codexqa", "least-loaded reviewer that is not the member");
  const aged = items.map(entry => (entry.id === "reserved" ? item("reserved", { tags: ["hard", "H3", "build-ai_claude", "rev-ai_fo"], age: 30 }) : entry));
  assert.equal(nextFor(aged, "ai_codexqa", { now: NOW, roster }).id, "reserved", "a reservation lapses after 24h");
  assert.equal(nextFor([item("x", { tags: ["hard", "rev-ai_grok"] })], "ai_grok", { now: NOW, roster }), null, "never your own review");
});

test("CLI reads a saved board and roster and refuses bad arguments", async () => {
  assert.throws(() => parseArgs(["next"]), /--member/);
  assert.throws(() => parseArgs(["dance"]), /lane, mix or next/);
  assert.deepEqual(rosterOf({ members: [{ id: "ai_fo", handle: "Fo", kind: "agent" }, { handle: "no id" }] }), [{ id: "ai_fo", handle: "Fo", kind: "agent" }]);
  const dir = mkdtempSync(join(tmpdir(), "hard-work-"));
  const board = join(dir, "board.json"), rosterFile = join(dir, "roster.json");
  writeFileSync(board, JSON.stringify({ claims: [item("h", { tags: ["hard", "H2", "rev-ai_tab"] })] }));
  writeFileSync(rosterFile, JSON.stringify({ members: roster }));
  const lane = await main(["lane", "--board", board, "--roster", rosterFile], { now: NOW });
  assert.match(lane, /Hard lane: 1 open \(H3 0, H2 1/);
  assert.match(lane, /reviewer John's Tab/);
  const next = await main(["next", "--member", "ai_grok", "--board", board, "--roster", rosterFile], { now: NOW });
  assert.match(next, /Next: H2 h/);
  assert.match(next, /Partner: John's Tab \(named\)/);
});
