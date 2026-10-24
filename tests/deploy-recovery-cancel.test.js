// #3897: the guarded recovery step in deploy-prod must run exactly when a
// deploy may have left the canonical/entry Worker pair skewed: the
// pre-deploy snapshot succeeded, the canonical upload was attempted (not
// skipped), and the job is failing or was cancelled. A token-presence
// regex cannot pin that Boolean contract (review on #3897), so this test
// parses the step's actual `if:` expression and evaluates it over the
// realistic outcome table.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/deploy-prod.yml", import.meta.url), "utf8"));
const step = workflow.jobs.deploy.steps.find((s) => s.id === "rollback");
assert.ok(step, "deploy-prod must keep the guarded recovery step (id: rollback)");
const CONDITION = step.if;
assert.equal(typeof CONDITION, "string");

// Minimal evaluator for the expression family the condition uses:
// status functions (always/failure/cancelled/success), step outcome
// lookups, string literals, == / !=, && / ||, ! and parentheses.
function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (source.startsWith("&&", i) || source.startsWith("||", i) ||
        source.startsWith("==", i) || source.startsWith("!=", i)) {
      tokens.push({ type: "op", value: source.slice(i, i + 2) }); i += 2; continue;
    }
    if (ch === "!" || ch === "(" || ch === ")") { tokens.push({ type: "op", value: ch }); i += 1; continue; }
    if (ch === "'") {
      const end = source.indexOf("'", i + 1);
      assert.ok(end > i, `unterminated string literal in: ${source}`);
      tokens.push({ type: "string", value: source.slice(i + 1, end) }); i = end + 1; continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(source.slice(i));
    assert.ok(ident, `unexpected character '${ch}' in: ${source}`);
    tokens.push({ type: "ident", value: ident[0] }); i += ident[0].length;
  }
  return tokens;
}

function evaluate(source, ctx) {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseOr() {
    let left = parseAnd();
    while (peek()?.value === "||") { next(); const right = parseAnd(); left = Boolean(left) || Boolean(right); }
    return left;
  }
  function parseAnd() {
    let left = parseUnary();
    while (peek()?.value === "&&") { next(); const right = parseUnary(); left = Boolean(left) && Boolean(right); }
    return left;
  }
  function parseUnary() {
    if (peek()?.value === "!") { next(); return !parseUnary(); }
    return parseComparison();
  }
  function parseComparison() {
    const left = parsePrimary();
    if (peek()?.value === "==" || peek()?.value === "!=") {
      const op = next().value;
      const right = parsePrimary();
      return op === "==" ? left === right : left !== right;
    }
    return left;
  }
  function parsePrimary() {
    const tok = next();
    assert.ok(tok, `unexpected end of expression: ${source}`);
    if (tok.value === "(") { const value = parseOr(); assert.equal(next()?.value, ")"); return value; }
    if (tok.type === "string") return tok.value;
    if (tok.type === "ident") {
      if (peek()?.value === "(") {
        next(); assert.equal(next()?.value, ")", `only zero-argument status functions are supported: ${source}`);
        if (tok.value === "always") return true;
        if (tok.value === "failure") return ctx.status === "failure";
        if (tok.value === "cancelled") return ctx.status === "cancelled";
        if (tok.value === "success") return ctx.status === "success";
        throw new Error(`unsupported function ${tok.value} in: ${source}`);
      }
      const path = tok.value.split(".");
      assert.equal(path[0], "steps", `only steps.* lookups are supported: ${source}`);
      assert.equal(path[2], "outcome", `only steps.<id>.outcome lookups are supported: ${source}`);
      return ctx.steps[path[1]].outcome;
    }
    throw new Error(`unexpected token ${tok.value} in: ${source}`);
  }

  const value = parseOr();
  assert.equal(pos, tokens.length, `trailing tokens in: ${source}`);
  return Boolean(value);
}

const CASES = [
  // [job status, pre.outcome, prod.outcome, expected, why]
  ["success", "success", "success", false, "a successful deploy never recovers"],
  ["success", "success", "failure", false, "neither failure() nor cancelled() holds, so no recovery"],
  ["failure", "success", "failure", true, "the classic failed upload after a good snapshot"],
  ["cancelled", "success", "failure", true, "#3897: a cancelled run after the canonical upload was attempted"],
  ["cancelled", "success", "cancelled", true, "cancel landed mid-upload: attempted, not skipped"],
  ["cancelled", "success", "success", true, "cancel after the canonical upload but before the pair completed"],
  ["failure", "success", "success", true, "a later step failed after the canonical upload; the deploy is incomplete"],
  ["cancelled", "failure", "failure", false, "no good snapshot to recover to"],
  ["cancelled", "skipped", "failure", false, "the snapshot never completed"],
  ["cancelled", "success", "skipped", false, "the canonical upload was never attempted: nothing to skew"],
  ["failure", "success", "skipped", false, "same guard on the failure path"],
];

test("deploy-prod recovery condition matches its truth table (#3897)", () => {
  for (const [status, pre, prod, expected, why] of CASES) {
    const ctx = { status, steps: { pre: { outcome: pre }, prod: { outcome: prod } } };
    assert.equal(evaluate(CONDITION, ctx), expected,
      `status=${status} pre=${pre} prod=${prod}: expected ${expected} — ${why}`);
  }
});

test("the evaluator itself detects the pre-fix condition's blind spot", () => {
  // Calibration: the old failure()-only condition must read false for the
  // cancelled case, or the evaluator no longer detects the #3897 defect.
  const legacy = "failure() && steps.pre.outcome == 'success' && steps.prod.outcome != 'skipped'";
  const ctx = { status: "cancelled", steps: { pre: { outcome: "success" }, prod: { outcome: "failure" } } };
  assert.equal(evaluate(legacy, ctx), false);
  assert.equal(evaluate(CONDITION, ctx), true);
});
