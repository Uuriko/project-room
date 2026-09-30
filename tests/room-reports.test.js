// Agent-room steal 1: artifact-tag extractor + room report composition.
// Authoring gate: these guard the public tag-vocabulary contract (agents and
// the later /api/rooms/{id}/report route rely on [DECISION]/[TODO]/[STATUS]/
// [RESULT] extracting into typed, ordered artifacts) and the composition
// invariants — verified-done tasks lead highlights, tagged artifacts win over
// keyword fallbacks, outputs are frozen, malformed inputs throw ReportError.
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractArtifacts,
  buildRoomReport,
  artifactLabel,
  ReportError,
} from "../server/room-reports.mjs";

const throwsCode = (fn, code) =>
  assert.throws(fn, (error) => error instanceof ReportError && error.code === code);

const msg = (over = {}) => ({
  id: "m1",
  author: "ada",
  text: "plain line",
  time: 1759100000000,
  ...over,
});

test("extracts all four tag kinds, case-insensitively, several per message", () => {
  const arts = extractArtifacts([
    msg({ id: "a", author: "ada", text: "[DECISION] ship the dashboard\nrandom chatter\n[todo] write the docs" }),
    msg({ id: "b", author: "bob", text: "[Status] blocked on review" }),
    msg({ id: "c", author: "cara", text: "[RESULT] tests pass on main" }),
  ]);
  assert.deepEqual(arts.map((a) => a.kind), ["decision", "todo", "status", "result"]);
  assert.equal(arts[0].text, "ship the dashboard");
  assert.equal(arts[0].author, "ada");
  assert.equal(arts[0].sourceMessageId, "a");
  assert.equal(arts[0].id, "a-0");
  assert.equal(arts[1].id, "a-1"); // per-message index increments
  assert.ok(Object.isFrozen(arts) && Object.isFrozen(arts[0]));
});

test("ignores empty tag text and non-message entries", () => {
  const arts = extractArtifacts([
    msg({ text: "[TODO]   \n[DONE] not a real tag" }),
    null,
    { id: "x", author: "bob" },
    msg({ id: "y", text: "no tags here" }),
  ]);
  assert.equal(arts.length, 0);
});

test("artifactLabel covers the vocabulary and rejects unknowns", () => {
  assert.equal(artifactLabel("decision"), "Decision");
  assert.equal(artifactLabel("todo"), "Todo");
  assert.equal(artifactLabel("status"), "Status");
  assert.equal(artifactLabel("result"), "Result");
  throwsCode(() => artifactLabel("verdict"), "invalid_report");
});

test("buildRoomReport puts verified-done tasks first in highlights", () => {
  const report = buildRoomReport({
    room: { id: "r1", name: "alpha", topic: "launch", participants: [{ name: "ada" }, { name: "bob" }] },
    messages: [
      msg({ id: "a", author: "ada", text: "[DECISION] ship the dashboard" }),
      msg({ id: "b", author: "bob", text: "[TODO] write the migration guide" }),
      msg({ id: "c", author: "cara", text: "just chatting about the weather today" }),
    ],
    doneTasks: [{ id: "w1", title: "auth flow" }],
    now: 1759100000000,
  });
  assert.equal(report.highlights[0], "Verified done: auth flow");
  assert.deepEqual(report.decisions, ["ada: ship the dashboard"]);
  assert.deepEqual(report.actionItems, ["bob: write the migration guide"]);
  assert.equal(report.artifacts.length, 2);
  assert.equal(report.messageCount, 3);
  assert.equal(report.generatedAt, 1759100000000);
  assert.ok(report.summary.includes("1 task(s) verified done"));
  assert.ok(Object.isFrozen(report) && Object.isFrozen(report.decisions) && Object.isFrozen(report.transcript));
});

test("keyword fallbacks fire only when no tags are present", () => {
  const report = buildRoomReport({
    room: { id: "r2", name: "beta" },
    messages: [
      msg({ id: "a", author: "ada", text: "we agreed to ship on friday" }),
      msg({ id: "b", author: "bob", text: "next step: cut the release branch" }),
    ],
    doneTasks: [],
  });
  assert.ok(report.decisions.some((d) => d.includes("ship on friday")));
  assert.ok(report.actionItems.some((a) => a.includes("cut the release branch")));
});

test("tagged artifacts always beat keyword fallback lines", () => {
  const report = buildRoomReport({
    room: { id: "r3", name: "gamma" },
    messages: [
      msg({ id: "a", author: "ada", text: "we agreed to ship on friday" }),
      msg({ id: "b", author: "bob", text: "[DECISION] hold the launch" }),
    ],
    doneTasks: [],
  });
  assert.deepEqual(report.decisions, ["bob: hold the launch"]);
});

test("empty rooms still get a usable report shell", () => {
  const report = buildRoomReport({ room: { id: "r4", name: "quiet" }, messages: [] });
  assert.equal(report.messageCount, 0);
  assert.equal(report.highlights.length, 0);
  assert.equal(report.actionItems.length, 1); // default next-step prompt
});

test("malformed inputs are refused with ReportError", () => {
  throwsCode(() => extractArtifacts("nope"), "invalid_report");
  throwsCode(() => buildRoomReport({}), "invalid_report");
  throwsCode(() => buildRoomReport({ room: { id: "" }, messages: [] }), "invalid_report");
  throwsCode(() => buildRoomReport({ room: { id: "r" }, messages: "nope" }), "invalid_report");
  throwsCode(() => buildRoomReport({ room: { id: "r" }, messages: [], doneTasks: "nope" }), "invalid_report");
});
