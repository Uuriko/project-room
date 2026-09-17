import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatchJournal, createFakeProvider, dispatchOnce, reconcile } from "../server/dispatch-journal.mjs";

// W4-39 G3: a lost response cannot cause duplicate execution.

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-journal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { path: join(dir, "dispatch.jsonl") };
}
const payload = { task: "render", inputRevision: 3 };

test("lost response: one job, attempt stays unknown, retry reconciles instead of resubmitting", t => {
  const { path } = fixture(t);
  const journal = new DispatchJournal(path);
  const provider = createFakeProvider();
  provider.dropResponses = true;
  const first = dispatchOnce({ journal, provider, key: "sub-1", roomId: "commons", workItemId: "w1", payload });
  assert.equal(first.lost, true);
  assert.equal(first.record.state, "unknown");
  assert.equal(provider.jobs.size, 1, "provider executed exactly once");

  // The caller retries after the lost response. No second execution.
  provider.dropResponses = false;
  const retry = dispatchOnce({ journal, provider, key: "sub-1", roomId: "commons", workItemId: "w1", payload });
  assert.equal(retry.submitted, false);
  assert.equal(provider.jobs.size, 1, "retry must not resubmit");

  // A later authoritative reply resolves that same attempt.
  const resolved = reconcile({ journal, provider, key: "sub-1" });
  assert.equal(resolved.state, "done");
  assert.equal(resolved.jobId, "job-1");
  assert.equal(provider.jobs.size, 1);
});

test("restart and replay add no job: a fresh journal over the same file never resubmits", t => {
  const { path } = fixture(t);
  const provider = createFakeProvider();
  provider.dropResponses = true;
  dispatchOnce({ journal: new DispatchJournal(path), provider, key: "sub-2", roomId: "commons", workItemId: "w1", payload });
  assert.equal(provider.jobs.size, 1);

  // Process restart: rebuild the journal from disk; the provider is a fresh
  // connection to the same service.
  provider.dropResponses = false;
  const reopened = new DispatchJournal(path);
  assert.equal(reopened.get("sub-2").state, "unknown");
  const again = dispatchOnce({ journal: reopened, provider, key: "sub-2", roomId: "commons", workItemId: "w1", payload });
  assert.equal(again.submitted, false);
  assert.equal(provider.jobs.size, 1, "restart must not duplicate execution");
  reconcile({ journal: reopened, provider, key: "sub-2" });
  assert.equal(reopened.get("sub-2").state, "done");
});

test("altered payload under the same key is refused before any provider call", t => {
  const { path } = fixture(t);
  const journal = new DispatchJournal(path);
  const provider = createFakeProvider();
  dispatchOnce({ journal, provider, key: "sub-3", roomId: "commons", workItemId: "w1", payload });
  assert.throws(() => dispatchOnce({ journal, provider, key: "sub-3", roomId: "commons", workItemId: "w1",
    payload: { task: "render", inputRevision: 4 } }), /Payload altered/);
  assert.equal(provider.jobs.size, 1);
});

test("crash between intend and submit reconciles instead of resubmitting", t => {
  const { path } = fixture(t);
  const journal = new DispatchJournal(path);
  const provider = createFakeProvider();
  journal.intend({ key: "sub-4", roomId: "commons", workItemId: "w1", payload }); // crash before submit
  const recovered = dispatchOnce({ journal, provider, key: "sub-4", roomId: "commons", workItemId: "w1", payload });
  assert.equal(recovered.submitted, false, "uncertain prior attempt is reconciled, not resubmitted");
  assert.equal(provider.jobs.size, 0, "provider never saw it, and we did not execute blind");
});
