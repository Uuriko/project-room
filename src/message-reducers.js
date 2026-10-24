// Pure message-domain reducers. The event coordinator retains envelope validation,
// event deduplication and state cloning. Shared authority guards are supplied once
// at composition, avoiding a dependency cycle back to the event coordinator.
import { normalizePoll } from './polls.js';
import { prepareReplyPost, recordReplyPost } from './reply-requests.js';

export function isRedactedBody(data) {
  return data?.redacted === true && data.body == null;
}

export function createMessageReducers({ requireMember, knownMember, requireFields,
  requireWorkItem, proposalContext, validId, messageChannelId, defaultChannelId, channelArchivedCode,
  pinLimit, pinDmPartyPolicyVersion }) {
  function postMessage(state, incoming) {
    const actor = requireMember(state, incoming.actorId);
    // --- PRIV-1 message redaction ---
    // A rewritten log stores body null and redacted true. Replay still has to
    // build the same message, including a channel copy, without the text.
    const redacted = isRedactedBody(incoming.data);
    if (!redacted) requireFields(incoming.data, ["body"]);
    // --- end PRIV-1 message redaction ---
    const requestMode = prepareReplyPost(state, incoming);
    if (incoming.data.toMemberId) (requestMode === "respond" ? knownMember : requireMember)(state, incoming.data.toMemberId);
    if (!redacted && typeof incoming.data.body !== "string") throw new Error("Message body must be text");
    // ACT-1a: receipt cards and starter choice buttons. Absent on ordinary posts.
    // Polls (missing-features #5): kind "poll" carries a validated poll payload.
    if (incoming.data.kind != null && !["receipt_card", "poll"].includes(incoming.data.kind)) throw new Error("Message kind must be receipt_card or poll");
    const poll = incoming.data.kind === "poll" ? normalizePoll(incoming.data) : null;
    if (incoming.data.kind === "receipt_card") {
      requireFields(incoming.data, ["claimId", "title", "closedBy", "deliveryMode", "evidence"]);
      if (!["result", "merged", "production"].includes(incoming.data.deliveryMode)) throw new Error("Invalid deliveryMode");
    }
    if (incoming.data.workItemId) requireWorkItem(state, incoming.data.workItemId);
    // Replies pin to their thread root's channel so a thread can't drift across
    // channels, no matter what channelId the command carries.
    let channelId = incoming.data.channelId || defaultChannelId;
    if (incoming.data.replyToId) {
      let root = state.messages.find(m => m.id === incoming.data.replyToId);
      if (!root) throw new Error("Reply must reference a message in this Room");
      while (root.replyToId) {
        const parent = state.messages.find(m => m.id === root.replyToId);
        if (!parent) break;
        root = parent;
      }
      channelId = messageChannelId(root);
    }
    const channel = state.channels[channelId];
    if (!channel) throw new Error("Unknown channel");
    if (channel.archivedAt) {
      const error = new Error("Channel is archived");
      error.code = channelArchivedCode;
      throw error;
    }
    const proposal = proposalContext(incoming.data, state.workItems[incoming.data.workItemId]);
    if (state.messages.some(m => m.id === (incoming.data.messageId || incoming.id))) throw new Error("Message already exists");
    state.messages.push({
      id: incoming.data.messageId || incoming.id,
      authorId: actor.id,
      body: incoming.data.body,
      ...(redacted ? { redacted: true } : {}),
      channelId,
      workItemId: incoming.data.workItemId || null,
      replyToId: incoming.data.replyToId || null,
      toMemberId: incoming.data.toMemberId || null,
      createdAt: incoming.at,
      ...(proposal ? { proposal } : {}),
      ...(Array.isArray(incoming.data.actions) ? { actions: incoming.data.actions.map(action => ({ claimId: action.claimId, label: action.label })) } : {}),
      ...(incoming.data.kind === "receipt_card" ? {
        kind: "receipt_card",
        claimId: incoming.data.claimId,
        // Run-receipt link (rc_<claimId>): newer posters carry receiptId on the
        // event; older cards derive it so every card projects the link the
        // receipts surface resolves.
        receiptId: incoming.data.receiptId || `rc_${incoming.data.claimId}`,
        title: incoming.data.title,
        closedBy: incoming.data.closedBy,
        deliveryMode: incoming.data.deliveryMode,
        evidence: incoming.data.evidence,
        ...(incoming.data.pullRequestUrl ? { pullRequestUrl: incoming.data.pullRequestUrl } : {})
      } : {}),
      ...(poll ? { kind: "poll", poll } : {})
    });
    // "Also send to channel": a public thread reply also lands as a top-level
    // message in the thread's channel, in the same event. The derived id is
    // deterministic (validId-safe suffix) so replay and retried commands stay
    // idempotent. DMs and work proposals never copy — a DM copy would leak the
    // private body, and a proposal's work context doesn't survive as a plain
    // message.
    if (incoming.data.alsoSendToChannel && incoming.data.replyToId && !incoming.data.toMemberId && !incoming.data.workItemId) {
      const copyId = `${incoming.data.messageId || incoming.id}:channel`;
      if (state.messages.some(m => m.id === copyId)) throw new Error("Message already exists");
      state.messages.push({
        id: copyId,
        authorId: actor.id,
        body: incoming.data.body,
        ...(redacted ? { redacted: true } : {}),
        channelId,
        workItemId: null,
        replyToId: null,
        toMemberId: null,
        createdAt: incoming.at
      });
    }
    recordReplyPost(state, incoming, requestMode);
  }


  // A message named by a completed work item's receipt is that work's result.
  // src/work-packet.js puts it plainly: "the immutable stored message is the
  // artifact". Nothing enforced it, so an edit was accepted and then broke
  // everything downstream at once - server/text-results.mjs storedText requires
  // the posted body to still equal the stored one, so GET work-result answered
  // 422 result_unavailable for that item forever while it went on reporting
  // state: completed with an evidenceVersion hash matching nothing retrievable,
  // and auditTextResults failed, which takes backupRoom down for the whole
  // database.
  //
  // Scoped to receipts, deliberately. auditTextResults only walks work.completed
  // events carrying room_text evidence, and a draft is meant to be revised.
  //
  // This refuses an owner's delete as well as an author's edit, which is the
  // uncomfortable half: removing harmful content that happens to be bound as
  // evidence now needs the receipt invalidated first, and there is no event for
  // that yet. That is worth building. It is still better than the present
  // behaviour, where the delete is accepted and silently destroys the artifact
  // plus the room's backups, because a refusal says so at the moment it happens.
  const evidenceReceipt = (state, messageId) => {
    for (const work of Object.values(state.workItems ?? {})) {
      for (const receipt of [...(work.receiptHistory ?? []), work.receipt]) {
        if (receipt?.nativeText?.messageId === messageId) return work;
      }
    }
    return null;
  };

  // Withdrawing text a work item recorded as its result. The receipt keeps
  // everything it ever claimed - who reported it, the hash a verifier signed off
  // against - and gains the fact that the text behind it is gone, so a reader
  // finds a withdrawal instead of a reference to a message the room no longer
  // shows. Every auditor that reconstructs a receipt has to replay this; see
  // auditTextResults in server/text-results.mjs.
  function withdrawTextEvidence(state, messageId, incoming) {
    for (const work of Object.values(state.workItems ?? {})) {
      for (const receipt of [...(work.receiptHistory ?? []), work.receipt]) {
        if (receipt?.nativeText?.messageId !== messageId) continue;
        receipt.nativeText.withdrawnAt = incoming.at;
        receipt.nativeText.withdrawnBy = incoming.actorId;
      }
    }
  }

  // `evidence: "refuse"` is for an edit, which would move the text behind a hash
  // somebody already verified, leaving the work item claiming a result that no
  // longer says what it said. `evidence: "withdraw"` is for a deletion, which
  // must stay available to whoever has to take harmful text out of a room: it
  // removes the text and records the withdrawal on the receipt.
  function findEditableMessage(state, incoming, { evidence = "refuse" } = {}) {
    const message = state.messages.find(m => m.id === incoming.data.messageId);
    if (!message) throw new Error("Message not found");
    if (message.deletedAt) throw new Error("Message was deleted");
    const evidenceFor = evidence === "refuse" ? evidenceReceipt(state, message.id) : null;
    if (evidenceFor) throw new Error(`This message is the recorded result of ${evidenceFor.id} and cannot be changed`);
    const actor = requireMember(state, incoming.actorId);
    if (message.authorId !== actor.id && actor.id !== state.room.ownerId) throw new Error("Only the author or the Room owner can change this message");
    // A missing token is not a change: the old single message asserted
    // "Message changed" when nothing had changed and the caller had simply
    // omitted the field — and neither variant named the field to supply
    // (UT-ERRORS row 5 / QA card 7a).
    if (incoming.data.expectedMessageRevision == null) throw new Error("expectedMessageRevision is required: resend with expectedMessageRevision set to the message's current revision (0 if it was never edited), which the conversation read shows");
    if ((message.revision ?? 0) !== incoming.data.expectedMessageRevision) throw new Error(`Message changed; refresh before editing and resend with expectedMessageRevision set to the current revision (current revision is ${message.revision ?? 0})`);
    return { message, actor };
  }

  // Edit history is bounded. Each edit used to append the previous body with no
  // cap, so enough edits of a long message pushed the room projection into the
  // 4 MiB pilot cap and refused every later write in the room (muse-room 12457
  // item 3, evidence 12458). Keep the most recent EDIT_HISTORY_MAX_ENTRIES prior
  // versions, each body capped at EDIT_HISTORY_MAX_BODY_CHARS, dropping the
  // oldest first; the newest entry is always kept so an edit is still marked.
  const EDIT_HISTORY_MAX_ENTRIES = 25;
  const EDIT_HISTORY_MAX_BODY_CHARS = 20000;
  // One message's history may never hold more than a 128th of the 4 MiB room
  // projection, so even the cap's ceiling cannot crowd out the room's writes.
  const EDIT_HISTORY_MAX_TOTAL_CHARS = 32768;

  function appendEditHistory(history, entry) {
    const size = (e) => (typeof e.body === "string" ? e.body.length : 0) + 64;
    const trimmed = typeof entry.body === "string" && entry.body.length > EDIT_HISTORY_MAX_BODY_CHARS
      ? { ...entry, body: entry.body.slice(0, EDIT_HISTORY_MAX_BODY_CHARS) }
      : entry;
    let prior = [...(history ?? []), trimmed];
    while (prior.length > 1 && (prior.length > EDIT_HISTORY_MAX_ENTRIES || prior.reduce((sum, e) => sum + size(e), 0) > EDIT_HISTORY_MAX_TOTAL_CHARS)) prior = prior.slice(1);
    return prior;
  }

  function editMessage(state, incoming) {
    const { message } = findEditableMessage(state, incoming);
    // --- PRIV-1 message redaction ---
    if (!isRedactedBody(incoming.data) && (typeof incoming.data.body !== "string" || !incoming.data.body.trim())) throw new Error("Message body must be text");
    // --- end PRIV-1 message redaction ---
    message.editHistory = appendEditHistory(message.editHistory, { body: message.body, editedAt: incoming.at });
    message.body = incoming.data.body;
    message.revision = (message.revision ?? 0) + 1;
    message.editedAt = incoming.at;
  }

  function deleteMessage(state, incoming) {
    const { message } = findEditableMessage(state, incoming, { evidence: "withdraw" });
    message.body = null;
    // Deletion hides every earlier version too; the tombstone keeps only who/when.
    message.editHistory = [];
    message.deletedAt = incoming.at;
    message.deletedBy = incoming.actorId;
    dropPinsForMessage(state, message.id); // issue #6 B2: the tombstone drops the pin too
    withdrawTextEvidence(state, message.id, incoming);
    message.revision = (message.revision ?? 0) + 1;
  }

  // --- PRIV-1 message redaction ---


  // Server-emitted. Owner delete, author delete, and account deletion all append
  // this after the text has been removed from earlier events. Replay must match
  // a live delete: bodies stay null, a prior delete's timestamp wins, and the
  // posted byte length is kept so a receipt can still name its hash.
  function redactMessage(state, incoming) {
    const actor = requireMember(state, incoming.actorId);
    const messageId = incoming.data?.messageId;
    if (!validId(messageId)) throw new Error("Event data missing messageId");
    const primary = state.messages.find(message => message.id === messageId);
    if (!primary) throw new Error("Message not found");
    if (primary.authorId !== actor.id && actor.id !== state.room.ownerId) {
      throw new Error("Only the author or the Room owner can change this message");
    }
    const ids = messageId.endsWith(":channel") ? [messageId] : [messageId, `${messageId}:channel`];
    for (const id of ids) {
      const message = state.messages.find(entry => entry.id === id);
      if (!message) continue;
      message.body = null;
      message.redacted = true;
      if (Array.isArray(message.editHistory)) {
        message.editHistory = message.editHistory.map(entry => ({ ...entry, body: null }));
      }
      if (message.attachments != null) message.attachments = null;
      if (!message.deletedAt) {
        message.deletedAt = incoming.at;
        message.deletedBy = incoming.actorId;
        dropPinsForMessage(state, message.id);
        message.revision = (message.revision ?? 0) + 1;
      }
    }
    if (!messageId.endsWith(":channel") && Number.isInteger(incoming.data.byteLength) && incoming.data.byteLength > 0) {
      primary.redactedByteLength = incoming.data.byteLength;
    }
    for (const work of Object.values(state.workItems ?? {})) {
      for (const receipt of [...(work.receiptHistory ?? []), work.receipt]) {
        if (receipt?.nativeText?.messageId !== messageId) continue;
        if (!receipt.nativeText.withdrawnAt) {
          receipt.nativeText.withdrawnAt = incoming.at;
          receipt.nativeText.withdrawnBy = incoming.actorId;
        }
        receipt.nativeText.evidence = "removed";
      }
    }
  }

  // A receipt that cited this message keeps its hash and gains one ledger line.
  function recordEvidenceWithdrawn(state, incoming) {
    requireMember(state, incoming.actorId);
    const messageId = incoming.data?.messageId;
    if (!validId(messageId)) throw new Error("Event data missing messageId");
    if (incoming.data?.evidence !== "removed") throw new Error("Evidence withdrawal must record removed");
    let cited = false;
    for (const work of Object.values(state.workItems ?? {})) {
      let here = false;
      for (const receipt of [...(work.receiptHistory ?? []), work.receipt]) {
        if (receipt?.nativeText?.messageId !== messageId) continue;
        here = true;
        cited = true;
        receipt.nativeText.evidence ??= "removed";
      }
      if (!here) continue;
      work.evidenceWithdrawals ??= [];
      if (!work.evidenceWithdrawals.some(entry => entry.messageId === messageId)) {
        work.evidenceWithdrawals.push({
          messageId,
          evidence: "removed",
          at: incoming.at,
          by: incoming.actorId,
          ...(Number.isInteger(incoming.data.byteLength) && incoming.data.byteLength > 0 ? { byteLength: incoming.data.byteLength } : {})
        });
      }
    }
    if (!cited) throw new Error("Message not found");
  }
  // --- end PRIV-1 message redaction ---

  // Polls: poll.voted { messageId, option, active } records one member's vote
  // on option index `option`. Votes live on the message as pollVotes, an array
  // of sorted member-id lists aligned with poll.options. Single-choice polls
  // move the vote; allowMultiple polls keep the others.
  function votePoll(state, incoming) {
    const actor = requireMember(state, incoming.actorId);
    requireFields(incoming.data, ["messageId", "option", "active"]);
    const { messageId, option, active } = incoming.data;
    const message = state.messages.find(m => m.id === messageId);
    if (!message) throw new Error("Vote must reference a message in this Room");
    if (message.deletedAt) throw new Error("Message was deleted");
    if (message.kind !== "poll" || !Array.isArray(message.poll?.options)) throw new Error("Vote must reference a poll");
    if (!Number.isInteger(option) || option < 0 || option >= message.poll.options.length || typeof active !== "boolean") throw new Error("Invalid poll vote");
    const votes = message.poll.options.map((_, i) => Array.isArray(message.pollVotes?.[i]) ? message.pollVotes[i] : []);
    message.pollVotes = votes.map((voters, i) => {
      const set = new Set(voters);
      if (i === option) { if (active) set.add(actor.id); else set.delete(actor.id); }
      else if (active && message.poll.allowMultiple !== true) set.delete(actor.id);
      return [...set].sort();
    });
  }


  function pinTarget(incoming) {
    const messageId = incoming.data?.messageId;
    if (typeof messageId !== "string" || !messageId.trim()) throw new Error("Missing required field: messageId");
    return messageId;
  }

  function pinMessage(state, incoming) {
    requireMember(state, incoming.actorId);
    const messageId = pinTarget(incoming);
    const message = state.messages.find(m => m.id === messageId);
    if (!message) throw new Error("Pin must reference a message in this Room");
    // A DM can only be pinned by one of its parties; the read paths filter
    // pins per viewer, but pinning a DM you cannot read is never legitimate.
    // Pins recorded before the policy stamp existed are legitimate history:
    // replay accepts them (the read paths still filter per viewer), while
    // every new pin carries the stamp (injected at live admission) and is
    // checked. Without this, one old non-party pin in a room log would make
    // rebuildProjection / log replay throw.
    if (message.toMemberId && message.authorId !== incoming.actorId && message.toMemberId !== incoming.actorId
        && incoming.data?.pinDmPartyPolicyVersion === pinDmPartyPolicyVersion) {
      throw new Error("Cannot pin a direct message you are not a party to");
    }
    // A redacted post keeps body null in the log before message.deleted. Replay
    // still has to accept the pin that happened while the text was readable.
    if (message.deletedAt || (message.body == null && message.redacted !== true)) throw new Error("A deleted message cannot be pinned");
    state.pins ??= [];
    if (state.pins.some(pin => pin.messageId === messageId)) return; // idempotent
    if (state.pins.length >= pinLimit) throw new Error(`Pin capacity reached: ${pinLimit} pinned messages per room; unpin one first`);
    state.pins.push({ messageId, pinnedById: incoming.actorId, pinnedAt: incoming.at });
  }

  function unpinMessage(state, incoming) {
    requireMember(state, incoming.actorId);
    const messageId = pinTarget(incoming);
    // A DM's pin can only be removed by one of its parties. Same stamp rule as
    // pinMessage: unpin events recorded before the stamp keep replaying.
    const message = state.messages.find(m => m.id === messageId);
    if (message?.toMemberId && message.authorId !== incoming.actorId && message.toMemberId !== incoming.actorId
        && incoming.data?.pinDmPartyPolicyVersion === pinDmPartyPolicyVersion) {
      throw new Error("Cannot unpin a direct message you are not a party to");
    }
    if (!state.pins?.length) return; // idempotent
    state.pins = state.pins.filter(pin => pin.messageId !== messageId);
  }

  function dropPinsForMessage(state, messageId) {
    if (state.pins?.some(pin => pin.messageId === messageId)) state.pins = state.pins.filter(pin => pin.messageId !== messageId);
  }


  return Object.freeze({postMessage,editMessage,deleteMessage,redactMessage,recordEvidenceWithdrawn,votePoll,pinMessage,unpinMessage});
}
