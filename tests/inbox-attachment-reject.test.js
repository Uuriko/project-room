// Shipped InboxClient rejects file-bearing send/review payloads. Not MCP.
import test from "node:test";
import assert from "node:assert/strict";
import { AccountClient } from "../src/client.js";
import { InboxClient, inboxTextVersion } from "../src/inbox-client.js";

const session = { authenticated: true, account: { id: "owner", authEpoch: 2 }, sessionRevision: 4, sessionBinding: "a".repeat(64), csrf: "csrf" };
const viewer = { accountId: "owner", authEpoch: 2, sessionRevision: 4, sessionBinding: session.sessionBinding };
const reply = value => ({ ok: true, json: async () => value });
function setup(fetcher) {
  const account = new AccountClient({ fetcher }); account.session = structuredClone(session);
  return new InboxClient(account);
}

test("sendContext rejects a preview that carries file attachments", async () => {
  const envelope = { adapter: "synthetic", accountId: "owner", authEpoch: 2, sourceId: "note", sourceRevision: 1, draftRevision: 1,
    from: "you@example.test", to: ["maya@example.test"], subject: "Launch", body: "Exact reply", attachments: [] };
  const preview = { ...envelope, previewVersion: (await inboxTextVersion(JSON.stringify(envelope))).slice(7) };
  const client = setup(async () => reply({ contractVersion: 1, viewer, sourceId: "note", simulationAvailable: true, preview }));
  assert.equal((await client.sendContext("note")).preview.attachments.length, 0);

  const withFile = { ...envelope, attachments: [{ filename: "notes.bin", bytes: 12 }] };
  const filePreview = { ...withFile, previewVersion: (await inboxTextVersion(JSON.stringify(withFile))).slice(7) };
  const blocked = setup(async () => reply({ contractVersion: 1, viewer, sourceId: "note", simulationAvailable: true, preview: filePreview }));
  await assert.rejects(blocked.sendContext("note"), { code: "invalid_inbox_response" });
});

test("replyReview rejects a reviewable draft that still lists attachments", async () => {
  const attempt = { id: "attempt", revision: 3, status: "awaiting_review", sourceRevision: 1, draftRevision: 1, canSend: false, canReview: true,
    observation: { version: "a".repeat(64), from: "me@example.test", sender: "me@example.test", to: ["you@example.test"], cc: [], bcc: [],
      subject: "Reply", body: "A private draft", format: "text", attachmentState: "complete", attachmentCount: 0, differences: [] }, review: null };
  const response = { contractVersion: 1, viewer, view: "reply-review-v4", sourceId: "mail", attempt, update: null,
    comparison: { originalBody: "Original reply", updateStatus: null } };
  const ok = setup(async () => reply(response));
  assert.equal((await ok.replyReview("mail")).attempt.observation.attachmentCount, 0);

  const attached = structuredClone(response);
  attached.attempt.observation.attachmentCount = 1;
  const blocked = setup(async () => reply(attached));
  await assert.rejects(blocked.replyReview("mail"), { code: "invalid_inbox_response" });
});
