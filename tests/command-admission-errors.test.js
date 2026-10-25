// Command admission maps reducer refusals to the status the message names:
// a missing field is input, and a second accept names who already accepted.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { agentErrorAx, errorCategory } from "../src/agent-error.mjs";

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  return f;
}

test("a work proposal with no title is an input error", t => {
  const f = fixture(t);
  assert.throws(() => f.store.command(f.keys.owner, "commons", {
    id: randomUUID(), type: "work.proposed",
    data: { workItemId: "missing-title", definitionOfDone: "done", accountableMemberId: "producer", mode: "read" }
  }), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, "invalid_command");
    assert.match(error.message, /missing title/);
    assert.equal(errorCategory(error.status, error.code), "input");
    const ax = agentErrorAx({ httpStatus: error.status, code: error.code, message: error.message });
    assert.equal(ax.hint.includes("silently rebase"), false);
    return true;
  });
});

test("a later accept names who already accepted the work", t => {
  const f = fixture(t);
  f.store.command(f.keys.producer, "commons", {
    id: randomUUID(), type: "work.accepted",
    data: { workItemId: "test-handoff", expectedRevision: 0 }
  });
  const item = f.store.room("commons").state.workItems["test-handoff"];
  const name = f.store.room("commons").state.members[item.accountableMemberId].displayName;
  const expectLost = error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "work_already_accepted");
    assert.equal(error.message, `Already accepted by ${name} at rev ${item.revision}`);
    assert.equal(errorCategory(error.status, error.code), "conflict");
    const ax = agentErrorAx({ httpStatus: error.status, code: error.code, message: error.message, workItemId: "test-handoff" });
    assert.match(ax.hint, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(ax.hint.includes("silently rebase"), false);
    return true;
  };
  assert.throws(() => f.store.command(f.keys.producer, "commons", {
    id: randomUUID(), type: "work.accepted",
    data: { workItemId: "test-handoff", expectedRevision: 0 }
  }), expectLost);
  assert.throws(() => f.store.command(f.keys.guest, "commons", {
    id: randomUUID(), type: "work.accepted",
    data: { workItemId: "test-handoff", expectedRevision: item.revision }
  }), expectLost);
});
