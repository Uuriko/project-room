// H006: dependency audit. Pure auditor tests; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { auditDependencies, DepAuditError } from "../server/dep-audit.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof DepAuditError && error.code === code);

test("risky patterns are flagged with scores and a level", () => {
  const { findings, score, level, total, bySeverity } = auditDependencies({
    dependencies: {
      "left-pad": "*",                       // high: unpinned
      "old-lib": "http://example.com/old.tgz", // critical: insecure-url
      "git-lib": "github:user/repo#main",      // medium: git-dependency
    },
    devDependencies: { "good-lib": "1.2.3" },
  });
  assert.equal(total, 3);
  assert.deepEqual(findings.map(f => f.rule).sort(), ["git-dependency", "insecure-url", "unpinned"]);
  assert.deepEqual(bySeverity, { critical: 1, high: 1, medium: 1, low: 0 });
  assert.equal(score, 10 + 5 + 2);
  assert.equal(level, "medium");
  assert.ok(Object.isFrozen(findings));
});
test("clean manifests score zero with level none", () => {
  const result = auditDependencies({ dependencies: { a: "1.2.3", b: "^4.5.6" } });
  assert.deepEqual([result.score, result.level, result.total], [0, "none", 0]);
});
test("malformed inputs are refused", () => {
  throwsCode(() => auditDependencies(null), "invalid_dep_audit");
  throwsCode(() => auditDependencies({ dependencies: { a: 42 } }), "invalid_dep_audit");
});
