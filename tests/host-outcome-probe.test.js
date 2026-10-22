// Probe for docs/HOST-OUTCOME-CONTRACT.md. Pins current behavior only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hostReplyBody } from "../client/host-result.mjs";

test("control-looking body text is content, never parsed", () => {
  for (const body of ["FAILED: build broke", "NEEDS_INPUT: which repo?", "> FAILED: quoted from a log"])
    assert.equal(hostReplyBody({ body }), body);
});

test("an outcome key is rejected today, so adding it is an explicit contract change", () => {
  assert.throws(() => hostReplyBody({ body: "x", outcome: "declined" }), /Invalid host result/);
});

test("run lifecycle actions and the delivered-requires-answered rule are as the contract states", () => {
  const src = readFileSync(new URL("../server/request-runs.mjs", import.meta.url), "utf8");
  assert.match(src, /\["claim", "working", "result_ready", "needs_attention", "delivered"\]/);
  assert.match(src, /input\.action === "delivered" && request\.status !== "answered"/);
  const runner = readFileSync(new URL("../client/request-runner.mjs", import.meta.url), "utf8");
  assert.match(runner, /responseOutcome: "answered"/);
});
