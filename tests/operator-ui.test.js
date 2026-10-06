// COVERAGE CREW lane5: unit tests for the pure operator-console helpers in
// src/operator-ui.js (confirmationPhrase, describeFailure).
// Authoring gate: these guard the typed confirmation that arms the
// destructive purge execute (a phrase slip enables execute on the wrong
// input) and the user-facing failure messages (a wrong 404/429/409 mapping
// misleads the operator mid-purge). Existing coverage: none — tests/ has
// zero references to src/operator-ui.js. The rest of the module is DOM and
// network code behind document guards; imported here, the module never
// touches the DOM, so no stubs are needed.
import test from "node:test";
import assert from "node:assert/strict";
import { confirmationPhrase, describeFailure } from "../src/operator-ui.js";

test("confirmationPhrase: single-room plan with a known title requires the title", () => {
  const targets = [{ kind: "room", id: "rm_1" }];
  assert.equal(confirmationPhrase(targets, new Map([["rm_1", "The Lounge"]])), "The Lounge");
});

test("confirmationPhrase: single-room plan without a known title falls back to the id", () => {
  const targets = [{ kind: "room", id: "rm_1" }];
  assert.equal(confirmationPhrase(targets, new Map()), "rm_1");
  assert.equal(confirmationPhrase(targets), "rm_1");
});

test("confirmationPhrase: multi-target plans use the count phrase", () => {
  assert.equal(confirmationPhrase([{ kind: "room", id: "a" }, { kind: "identity", id: "b" }]), "purge 2 targets");
});

test("confirmationPhrase: a single non-room target uses the singular count phrase", () => {
  assert.equal(confirmationPhrase([{ kind: "identity", id: "i_1" }]), "purge 1 target");
});

test("describeFailure: known statuses map to operator-readable messages", () => {
  assert.equal(describeFailure(404, null), "The token was not accepted, or the operator surface is not configured on this deployment.");
  assert.equal(describeFailure(429, {}), "Too many operator calls from this address. Wait a minute and try again.");
  assert.equal(
    describeFailure(409, { error: { code: "plan_changed" } }),
    "The data changed after this plan was made. Nothing was deleted. Plan again."
  );
});

test("describeFailure: server errors surface the message or fall back to the status", () => {
  assert.equal(describeFailure(500, { error: { message: "disk full" } }), "Refused (500): disk full");
  assert.equal(describeFailure(409, { error: { message: "stale revision" } }), "Refused (409): stale revision");
  assert.equal(describeFailure(503, null), "Request failed with status 503.");
  assert.equal(describeFailure(500, {}), "Request failed with status 500.");
});
