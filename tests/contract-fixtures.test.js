// contract-fixtures.test.js — shared contract fixtures as deliberate-change gates.
//
// The claim system's widely-consumed pure functions (the error-body builders
// and refusal classifier in src/agent-error.mjs, the claim state machine in
// server/work-claims.mjs) have their EXACT current shapes frozen in
// tests/fixtures/claim-error-contracts.json and
// tests/fixtures/work-claim-contracts.json. This suite deepEquals live output
// against those snapshots: a field rename, a reshaped 409 body, or an altered
// refusal code fails LOUDLY. That is the point — such a change must be
// deliberate, reviewed, and regenerated with
// node tests/fixtures/gen-contract-fixtures.mjs, never slipped in silently.
//
// Fixture convention: each case is { name, fn, args, expected } or
// { name, fn, args, throws: {name, code, message} }. args may contain
// { $ref: "<other case name>" } to reuse another case's expected output as
// input. Comparison happens at the wire-JSON level (JSON round-trip), so
// frozen objects and undefined-key noise cannot fake a pass.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentErrorAx, agentErrorBody } from "../src/agent-error.mjs";
import * as claims from "../server/work-claims.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = process.env.CONTRACT_FIXTURE_DIR ?? join(HERE, "fixtures");
const wire = value => JSON.parse(JSON.stringify(value));

const FNS = {
  agentErrorAx: args => agentErrorAx(args[0]),
  agentErrorBody: args => agentErrorBody(args[0]),
  createWork: args => claims.createWork(args[0], args[1]),
  claimWork: args => claims.claimWork(args[0], args[1], args[2]),
  updateWork: args => claims.updateWork(args[0], args[1], args[2]),
  releaseWork: args => claims.releaseWork(args[0], args[1], args[2]),
  closeWork: args => claims.closeWork(args[0], args[1], args[2]),
};

function loadFixture(file) {
  const doc = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
  assert.ok(Array.isArray(doc.cases) && doc.cases.length > 0, `${file} must carry cases`);
  return doc;
}

function resolveArg(value, byName) {
  if (Array.isArray(value)) return value.map(v => resolveArg(v, byName));
  if (value && typeof value === "object") {
    if (typeof value.$ref === "string") {
      const target = byName.get(value.$ref);
      assert.ok(target && target.expected, `$ref target missing: ${value.$ref}`);
      return wire(target.expected);
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveArg(v, byName)]));
  }
  return value;
}

function runFixtureFile(file) {
  const doc = loadFixture(file);
  const byName = new Map(doc.cases.map(c => [c.name, c]));
  describe(`contract fixtures: ${file}`, () => {
    for (const c of doc.cases) {
      it(c.name, () => {
        const fn = FNS[c.fn];
        assert.ok(fn, `unknown fixture fn: ${c.fn}`);
        const args = resolveArg(c.args, byName);
        if (c.throws) {
          let thrown = null;
          try { fn(args); } catch (err) { thrown = err; }
          assert.ok(thrown, `${c.name}: expected a refusal, the call succeeded`);
          assert.deepEqual(
            wire({ name: thrown.name, code: thrown.code, message: thrown.message }),
            c.throws,
            `${c.name}: refusal shape changed — review as a contract change`,
          );
          return;
        }
        const actual = wire(fn(args));
        if (c.redact) {
          for (const key of c.redact) {
            if (key === "errorId") assert.match(String(actual[key] ?? ""), /^eid_[A-Za-z0-9_-]+$/, `${c.name}: errorId format`);
            if (key === "fingerprint") assert.match(String(actual[key] ?? ""), /^[0-9a-f]{64}$/, `${c.name}: fingerprint format`);
            actual[key] = "<redacted>";
          }
        }
        assert.deepEqual(
          actual, c.expected,
          `${c.name}: contract shape changed — rename/reshape must be deliberate and the fixture regenerated`,
        );
      });
    }
  });
}

runFixtureFile("claim-error-contracts.json");
runFixtureFile("work-claim-contracts.json");
