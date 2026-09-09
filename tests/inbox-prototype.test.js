import test from "node:test";
import assert from "node:assert/strict";
import { InboxPreview } from "../scripts/inbox-prototype/model.mjs";

test("sample sharing projects selected paragraphs only, not a private conversation", () => {
  const model = new InboxPreview(), source = structuredClone(model.thread("launch"));
  const shared = model.share(model.shareTicket("launch"), [0, 1], "share");
  assert.equal(shared.body, source.paragraphs.slice(0, 2).join("\n\n"));
  assert.equal(JSON.stringify(model.roomView()).includes("4,200"), false);
  assert.equal(JSON.stringify(model.roomView()).includes("maya@example.test"), false);
  assert.deepEqual(model.thread("launch"), source);
  model.thread("launch").paragraphs[0] = "A private follow-up";
  assert.equal(model.roomView().messages.at(-1).body, shared.body);
});
test("sample sharing requires fresh selection and retains a stable operation identity", () => {
  const model = new InboxPreview(), ticket = model.shareTicket("launch");
  assert.throws(() => model.share(ticket, [], "empty"), /Choose/);
  assert.throws(() => model.share(ticket, [0, 0], "duplicate"), /Choose/);
  assert.throws(() => model.share(ticket, [4], "missing"), /Choose/);
  model.share(ticket, [0], "same"); model.share(ticket, [0], "same");
  assert.equal(model.messages.filter(m => m.id === "same").length, 1);
  assert.throws(() => model.share(ticket, [1], "same"), /different/);
  model.thread("launch").revision++;
  assert.throws(() => model.share(ticket, [0], "stale"), /Source changed/);
});
test("sample unknown replies reconcile one exact attempt without claiming delivery", () => {
  const model = new InboxPreview(), thread = model.thread("coffee");
  const command = { id: "send", threadId: thread.id, revision: thread.revision, body: "Friday works",
    to: thread.address, from: thread.account };
  assert.equal(model.reply(command, "lost"), null);
  assert.deepEqual(model.reconcile("send"), { id: "send", status: "sample_recorded", delivered: false });
  assert.deepEqual(model.reply(command), model.reconcile("send"));
  assert.equal(model.operations.size, 1);
  assert.throws(() => model.reply({ ...command, body: "changed" }), /changed/);
  assert.throws(() => model.reply({ ...command, id: "offline" }, "offline"), /unavailable/);
  assert.equal(model.operations.size, 1);
  model.thread("coffee").revision++;
  assert.throws(() => model.reply({ ...command, id: "stale" }), /changed/);
});
test("ordinary sample chat and private reply drafts need no task or agent", () => {
  const model = new InboxPreview();
  model.setDraft("reply:coffee", "My private reply"); model.setDraft("room", "Hello");
  model.postChat(model.draft("room"), "chat");
  assert.equal(model.draft("reply:coffee"), "My private reply"); assert.equal(model.draft("room"), "");
  assert.equal(model.roomView().messages.at(-1).body, "Hello");
  assert.equal("workItems" in model.roomView(), false);
});
