import { createHash } from "node:crypto";
import { validId } from "../src/events.js";
import { parsePullRequestUrl } from "./claim-coordination.mjs";
import { ServiceError } from "./service-error.mjs";

const SHA = /^[a-f0-9]{40}$/;
const prefix = "_github-work:";
const refuse = (status, code, message) => { throw new ServiceError(status, code, message); };
const keyOf = (roomId, repository, number) => prefix + JSON.stringify([roomId, repository, number]);

export function readGithubWorkRecord(store, key) {
  const row = store.db.prepare("SELECT config_json FROM work_claim_config WHERE room_id=?").get(key);
  return row ? JSON.parse(row.config_json) : null;
}
export function writeGithubWorkRecord(store, key, value) {
  store.db.prepare(`INSERT INTO work_claim_config(room_id,config_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(room_id) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at`)
    .run(key, JSON.stringify(value), store.now());
}

export function githubWorkAttachment(store, roomId, repository, number) {
  return readGithubWorkRecord(store, keyOf(roomId, repository, number));
}

export function threadGithubAttachment(store, roomId, workItemId) {
  const index = readGithubWorkRecord(store, keyOf(roomId, "thread", workItemId));
  const attachment = index && githubWorkAttachment(store, roomId, index.repository, index.number);
  if (!attachment) return null;
  const { repository, number, attachedHead, observedHead, state, sequence, next } = attachment;
  return { repository, number, attachedHead, observedHead, state, sequence, ...(next ? { next } : {}) };
}

function attachmentReply(roomId, attachment, replayed) {
  const { id, workItemId, repository, number, attachedHead, attachedState, eventId, sequence, receiptOperationId } = attachment;
  return { status: "attached", id, workItemId, repository, number, attachedHead, observedHead: attachedHead, state: attachedState, eventId, sequence, receiptOperationId, replayed,
    nextRead: { tool: "room_read_work", arguments: { roomId, workItemId, brief: true } } };
}

export async function attachGithubWork(store, { token, roomId, input, fence, recipe, observe }) {
  const parsed = parsePullRequestUrl(input?.pullRequest);
  if (!parsed || new URL(input.pullRequest).port || !Number.isSafeInteger(parsed.number)
      || ![input.workItemId, input.operationId].every(validId) || !SHA.test(input.expectedHead ?? "")
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
    refuse(422, "invalid_pr_attachment", "Choose a Work Thread, GitHub pull request, exact head, work revision and operation ID.");
  const repository = parsed.repo.toLowerCase();
  if (recipe?.roomId !== roomId || recipe.repository !== repository)
    refuse(409, "github_repository_unconfigured", "This Room has no review recipe for that repository.");
  const { workItemId, operationId, expectedHead, expectedRevision } = input;
  const key = keyOf(roomId, repository, parsed.number);
  const index = keyOf(roomId, "thread", workItemId);
  function inspect() {
    const { member, credentialScope } = store.authenticate(token, roomId, fence, { allowAccountSession: false });
    const work = store.workContext(token, roomId, workItemId, { expectedSessionBinding: fence }).work;
    if (credentialScope !== "room" || member.id !== work.accountableMemberId || !member.permissions.includes("complete_work"))
      refuse(403, "pr_attachment_forbidden", "Only the assigned producer can attach this pull request.");
    const saved = readGithubWorkRecord(store, key);
    if (saved) {
      if (saved.workItemId !== workItemId)
        refuse(409, "pull_already_attached", "The pull request already has a Work Thread in this Room.");
      if (saved.id === operationId && (saved.attachedHead !== expectedHead || saved.attachedRevision !== expectedRevision))
        refuse(409, "idempotency_conflict", "Reuse the original exact PR attachment input.");
      if (saved.id !== operationId)
        refuse(409, "thread_already_attached", "This thread already has a pull request. Read the current attachment.");
      return { saved };
    }
    if (readGithubWorkRecord(store, index)) refuse(409, "thread_already_attached", "This thread already has a pull request.");
    if (work.revision !== expectedRevision || !["accepted", "working"].includes(work.state))
      refuse(409, "stale_work_revision", "Read the current Work Thread before attaching a pull request.");
    if (work.claim?.repository && work.claim.repository.toLowerCase().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "") !== repository)
      refuse(409, "pr_claim_repository_mismatch", "The current work claim names a different repository.");
    return { member };
  }
  const before = inspect();
  if (before.saved) return attachmentReply(roomId, before.saved, true);
  const observation = await observe(recipe, { number: parsed.number, head: expectedHead });
  if (!observation.snapshot || observation.snapshot.head !== expectedHead || observation.snapshot.number !== parsed.number
      || observation.snapshot.repository !== repository || observation.snapshot.state !== "open")
    refuse(409, observation.reason ?? "pr_head_unconfirmed", "Read the current GitHub pull request before attaching it.");
  return store.transaction(() => {
    const { member, saved } = inspect();
    if (saved) return attachmentReply(roomId, saved, true);
    const id = "github-attached-" + createHash("sha256").update(JSON.stringify([roomId, member.id, operationId])).digest("hex");
    const result = store.command(token, roomId, { id, type: "message.posted", data: {
      messageId: id, workItemId, body: `Attached PR ${parsed.url}\nCandidate revision: ${expectedHead}`,
    } }, fence);
    const attachment = { id: operationId, workItemId, producerId: member.id, repository, number: parsed.number, attachedHead: expectedHead,
      receiptOperationId: id, attachedRevision: expectedRevision, observedHead: expectedHead, state: observation.snapshot.draft ? "draft" : "open",
      attachedState: observation.snapshot.draft ? "draft" : "open", eventId: result.event.id, sequence: result.sequence };
    writeGithubWorkRecord(store, key, attachment);
    writeGithubWorkRecord(store, index, { repository, number: parsed.number });
    return attachmentReply(roomId, attachment, false);
  });
}

export function updateGithubWorkObservation(store, roomId, repository, number, snapshot) {
  return store.transaction(() => {
    const key = keyOf(roomId, repository, number);
    const saved = readGithubWorkRecord(store, key);
    if (!saved) return null;
    const state = snapshot.draft ? "draft" : snapshot.merged ? "merged" : snapshot.state;
    const next = { ...saved, observedHead: snapshot.head, state, next: snapshot.next };
    if (next.observedHead !== saved.observedHead || next.state !== saved.state
        || JSON.stringify(next.next) !== JSON.stringify(saved.next)) writeGithubWorkRecord(store, key, next);
    return next;
  });
}
