// Shared invented mailbox/update fixture. Never contacts a provider.
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { emailContractFixture } from "./email-contract-fixture.mjs";
import { seedRecordedReply } from "./reply-review-fixture.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";
import { prepareGraphReplyUpdate, currentGraphReplyUpdate, inspectGraphReplyUpdate } from "../server/graph-reply-draft.mjs";

export function createReplyUpdateFixture(t) {
  const f = createAcceptanceFixture(), raw = emailContractFixture(), account = f.store.accountForMember("commons", "owner");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  raw.connection.accountId = account.id;
  const slot = f.store.createAccountSessionSlot();
  const binding = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(account.id), 0).sessionBinding;
  const args = { store: f.store, token: slot.token, binding };
  f.store.email.apply(args.token, { action: "connection.configure", requestId: "connect", connectionId: raw.connection.id,
    expectedRevision: 0, profile: raw.connection }, binding);
  const envelope = normalizeGraphEmail(raw.connection, raw.message, raw.options); args.sourceId = envelope.sourceId;
  const page = { action: "page.apply", requestId: "import", connectionId: raw.connection.id, connectionRevision: 1,
    folderId: raw.message.parentFolderId, expectedRevision: 0, expectedCursor: null, cursor: "cursor", reset: true, complete: true,
    observations: [{ kind: "message", expectedSourceRevision: 0, envelope }] };
  f.store.email.apply(args.token, page, binding);
  const seed = seedRecordedReply(args);
  args.attemptId = seed.plan.requestId; args.requestId = "propose-update";
  const attempt = () => f.store.inbox.replyAttempts(args.token, args.sourceId, binding).attempts.find(a => a.id === args.attemptId);
  const save = body => {
    const { source, draft } = f.store.inbox.read(args.token, args.sourceId, binding);
    return f.store.inbox.apply(args.token, { action: "draft.save", requestId: crypto.randomUUID(), sourceId: args.sourceId,
      sourceRevision: source.revision, expectedRevision: draft.revision, body }, binding);
  };
  const prepare = (extra = {}) => prepareGraphReplyUpdate({ ...args, expectedRevision: attempt().revision, ...extra });
  const response = () => {
    const draft = attempt().observation.draft, address = value => ({ emailAddress: value });
    const message = { ...structuredClone(raw.message), id: seed.providerDraftId, changeKey: draft.revision,
      isDraft: true, hasAttachments: false, from: address(draft.from), sender: address(draft.sender),
      toRecipients: draft.to.map(address), ccRecipients: draft.cc.map(address), bccRecipients: draft.bcc.map(address),
      subject: draft.subject, replyTo: [], body: { contentType: "text", content: draft.body } };
    return { status: 200, connection: raw.connection, message, options: { idType: "immutable",
      attachmentObservation: { messageId: message.id, messageRevision: message.changeKey, complete: true, items: [] } } };
  };
  const record = response => f.store.inbox.recordReplyObservation(args.token, { sourceId: args.sourceId,
    attemptId: args.attemptId, requestId: crypto.randomUUID(), expectedRevision: attempt().revision, response }, binding);
  return { ...f, raw, account, args, page, seed, attempt, save, prepare, response, record,
    current: proposal => currentGraphReplyUpdate({ ...args, proposal }),
    inspect: (proposal, response) => inspectGraphReplyUpdate({ ...args, proposal, response }) };
}
