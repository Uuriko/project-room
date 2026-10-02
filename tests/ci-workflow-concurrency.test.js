// Contract: a push to refs/heads/main must not cancel the in-progress `test`
// or `schema-gate` run, and every main push must share one concurrency group
// so GitHub keeps only the newest pending run. Pull requests still cancel
// their own older runs. This is the deploy-on-green starvation guard: after
// #1371, cancel-in-progress was true for every non-dispatch event, so each
// main merge aborted the running main SHA before `test` and `schema-gate`
// could finish.
//
// The workflow YAML is the boundary GitHub evaluates. There is no runtime
// function to call. The evaluator below interprets the concurrency
// expressions; a behavior-preserving rewrite still passes, and restoring
// `github.event_name != 'workflow_dispatch'` fails.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");

const truthy = (value) => value !== false && value !== 0 && value !== "" && value != null;

function evaluateGithubExpression(raw, ctx) {
  const trimmed = String(raw).trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const wrapped = trimmed.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/);
  if (!wrapped) throw new Error(`unsupported expression: ${raw}`);
  const source = wrapped[1];
  let i = 0;

  function skip() {
    while (i < source.length && /\s/.test(source[i])) i += 1;
  }

  function parseOr() {
    let left = parseAnd();
    while (source.startsWith("||", skipTo())) {
      i += 2;
      const right = parseAnd();
      left = truthy(left) ? left : right;
    }
    return left;
  }

  function skipTo() {
    skip();
    return i;
  }

  function parseAnd() {
    let left = parseEquality();
    while (source.startsWith("&&", skipTo())) {
      i += 2;
      const right = parseEquality();
      left = truthy(left) ? right : left;
    }
    return left;
  }

  function parseEquality() {
    let left = parseUnary();
    skip();
    if (source.startsWith("==", i)) {
      i += 2;
      return left === parseUnary();
    }
    if (source.startsWith("!=", i)) {
      i += 2;
      return left !== parseUnary();
    }
    return left;
  }

  function parseUnary() {
    skip();
    if (source[i] === "!") {
      i += 1;
      return !truthy(parseUnary());
    }
    return parsePrimary();
  }

  function parsePrimary() {
    skip();
    const ch = source[i];
    if (ch === "(") {
      i += 1;
      const value = parseOr();
      skip();
      if (source[i] !== ")") throw new Error(`expected ) in ${source}`);
      i += 1;
      return value;
    }
    if (ch === "'" || ch === "\"") return parseString();
    const ident = source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.]*/);
    if (!ident) throw new Error(`expected value at ${source.slice(i)}`);
    i += ident[0].length;
    skip();
    if (source[i] === "(") return parseCall(ident[0]);
    if (ident[0] === "true") return true;
    if (ident[0] === "false") return false;
    if (!Object.hasOwn(ctx, ident[0])) throw new Error(`unbound ${ident[0]}`);
    return ctx[ident[0]];
  }

  function parseString() {
    const quote = source[i];
    i += 1;
    let out = "";
    while (i < source.length && source[i] !== quote) {
      out += source[i];
      i += 1;
    }
    if (source[i] !== quote) throw new Error("unterminated string");
    i += 1;
    return out;
  }

  function parseCall(name) {
    if (name !== "format") throw new Error(`unsupported function ${name}`);
    i += 1;
    const args = [];
    skip();
    if (source[i] !== ")") {
      args.push(parseOr());
      skip();
      while (source[i] === ",") {
        i += 1;
        args.push(parseOr());
        skip();
      }
    }
    if (source[i] !== ")") throw new Error("expected ) after format");
    i += 1;
    const [template, ...values] = args;
    return String(template).replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ""));
  }

  const value = parseOr();
  skip();
  if (i !== source.length) throw new Error(`trailing ${source.slice(i)}`);
  return value;
}

function workflowConcurrency(file) {
  const text = readFileSync(join(WORKFLOWS, file), "utf8");
  const name = text.match(/^name:\s*(\S+)\s*$/m)?.[1];
  const block = text.match(/^concurrency:\n((?:  .*\n)+)/m)?.[1];
  assert.ok(name, `${file}: missing workflow name`);
  assert.ok(block, `${file}: missing concurrency block`);
  const field = (key) => {
    const match = block.match(new RegExp(`^  ${key}: (.+)$`, "m"));
    assert.ok(match, `${file}: missing concurrency.${key}`);
    return match[1].trim();
  };
  return { file, name, group: field("group"), cancel: field("cancel-in-progress") };
}

function context(workflow, { event_name, ref, run_id }) {
  return {
    "github.event_name": event_name,
    "github.ref": ref,
    "github.workflow": workflow,
    "github.run_id": run_id,
  };
}

function assertMainDoesNotCancelInProgress(file) {
  const concurrency = workflowConcurrency(file);
  const mainA = context(concurrency.name, { event_name: "push", ref: "refs/heads/main", run_id: "1001" });
  const mainB = context(concurrency.name, { event_name: "push", ref: "refs/heads/main", run_id: "1002" });
  const pull = context(concurrency.name, { event_name: "pull_request", ref: "refs/pull/42/merge", run_id: "2001" });
  const otherPull = context(concurrency.name, { event_name: "pull_request", ref: "refs/pull/43/merge", run_id: "2002" });
  const dispatch = context(concurrency.name, { event_name: "workflow_dispatch", ref: "refs/heads/main", run_id: "3001" });
  const otherDispatch = context(concurrency.name, { event_name: "workflow_dispatch", ref: "refs/heads/main", run_id: "3002" });

  const cancel = (ctx) => evaluateGithubExpression(concurrency.cancel, ctx);
  const group = (ctx) => evaluateGithubExpression(concurrency.group, ctx);

  assert.equal(cancel(mainA), false, `${file}: a main push must not cancel the in-progress run`);
  assert.equal(cancel(mainB), false, `${file}: a later main push must not cancel the in-progress run`);
  assert.equal(group(mainA), group(mainB), `${file}: main pushes must share one concurrency group`);
  assert.equal(typeof group(mainA), "string");
  assert.ok(group(mainA).length > 0, `${file}: main group must be non-empty`);
  assert.equal(group(mainA).includes("1001"), false, `${file}: main group must not be per-run`);
  assert.equal(group(mainA).includes("1002"), false, `${file}: main group must not be per-run`);

  assert.equal(cancel(pull), true, `${file}: a pull request must still cancel its older run`);
  assert.notEqual(group(pull), group(mainA), `${file}: a pull request must not join the main group`);
  assert.notEqual(group(pull), group(otherPull), `${file}: pull requests must not cancel each other`);

  assert.equal(cancel(dispatch), false, `${file}: workflow_dispatch must not cancel in progress`);
  assert.notEqual(group(dispatch), group(mainA), `${file}: a manual run must not join the main group`);
  assert.notEqual(group(dispatch), group(otherDispatch), `${file}: manual runs must not cancel each other`);
}

test("main pushes never cancel an in-progress test or schema-gate run", () => {
  // Calibration: the #1371 expression cancels a main push. If this fails, the
  // evaluator no longer detects the regression the assertions below guard.
  const legacy = "${{ github.event_name != 'workflow_dispatch' }}";
  const mainPush = context("test", { event_name: "push", ref: "refs/heads/main", run_id: "9" });
  assert.equal(evaluateGithubExpression(legacy, mainPush), true);

  for (const file of ["test.yml", "schema-gate.yml"]) assertMainDoesNotCancelInProgress(file);
});
