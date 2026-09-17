// K025: OKR tracker. Pure OKR tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createOkrs, OkrError } from "../server/okrs.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof OkrError && error.code === code);

test("create/add/update/score lifecycle", () => {
  const okrs = createOkrs();
  const obj = okrs.createObjective({ title: "Launch v1", ownerId: "ada" });
  assert.ok(obj.objectiveId.startsWith("obj-"));
  assert.ok(Object.isFrozen(obj));
  const kr1 = okrs.addKeyResult(obj.objectiveId, { description: "Sign 10 users", target: 10 });
  const kr2 = okrs.addKeyResult(obj.objectiveId, { description: "99.9% uptime", target: 99.9, unit: "%" });
  okrs.updateProgress(obj.objectiveId, { krId: kr1.krId, current: 5 });
  okrs.updateProgress(obj.objectiveId, { krId: kr2.krId, current: 99.9 });
  const result = okrs.score(obj.objectiveId);
  assert.ok(Math.abs(result.score - 0.75) < 0.001); // (0.5 + 1.0) / 2
  assert.equal(result.keyResults.length, 2);
});
test("progress caps at 1.0", () => {
  const okrs = createOkrs();
  const obj = okrs.createObjective({ title: "T", ownerId: "a" });
  const kr = okrs.addKeyResult(obj.objectiveId, { description: "D", target: 10 });
  const updated = okrs.updateProgress(obj.objectiveId, { krId: kr.krId, current: 15 });
  assert.equal(updated.progress, 1);
});
test("malformed inputs are refused", () => {
  const okrs = createOkrs();
  throwsCode(() => okrs.createObjective({ title: "", ownerId: "a" }), "invalid_okr");
  throwsCode(() => okrs.score("ghost"), "invalid_okr");
  const obj = okrs.createObjective({ title: "T", ownerId: "a" });
  throwsCode(() => okrs.score(obj.objectiveId), "invalid_okr"); // no KRs
});
