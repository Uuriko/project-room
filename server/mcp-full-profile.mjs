import { OutsideAgents } from "./outside-agents.mjs";
// Hosted MCP full profile: the local stdio room tools, on the same URL as
// the public join tools, behind Authorization: Bearer pri_….
//
// Each tool takes roomId because one identity secret can belong to many
// rooms. Reads call the store methods the HTTP agent routes already use.
// Writes call the same command builders as stdio, then RoomStore.command.
// Local attention tools stay off this URL: they read an operator directory.

import { resolveCatalogAgent, catalogCallDenial } from "./capability-visibility.mjs";
import { ServiceError } from "./service-error.mjs";
import { canonicalLane, normalizeActor } from "./bounty-escrow.mjs";
import { isGuestAgentMemberId } from "./guest-agent-links.mjs";

import { prepareWork } from "../client/work-preparation.mjs";
import { beginSelectedWork, findBeginReceipt } from "../client/begin-work.mjs";
import { validId } from "../src/events.js";
import { projectBoard } from "../src/board.js";
import { confirmsWorkReturn } from "../src/workflow.js";
import { workContextMarkdown } from "../client/room-agent.mjs";
import { roomTools, validRoomToolArguments, buildDraftCommand } from "../client/mcp-stdio.mjs";
import { bountyTools, isBountyTool, validBountyToolArguments } from "../client/bounty-tools.mjs";
import { trustTools, isTrustTool, validTrustToolArguments } from "../client/trust-tools.mjs";
import { isWorkTool, buildWorkCommand, confirmsAgentCommand, recordedWorkAction } from "../client/work-actions.mjs";
import { isHelpTool, buildHelpCommand, recordedHelpAction } from "../client/help-actions.mjs";
import { isReplyTool, replyRoute, buildReplyCommand, recordedReplyAction } from "../client/reply-actions.mjs";

const ALREADY_HOSTED = new Set(["room_check_access", "get_room_context", "room_list_work"]);
const roomIdField = { type: "string", minLength: 1, maxLength: 128, description: "Room id this identity is linked to." };

function withRoomId(entry) {
  return {
    name: entry.name,
    ...(entry.title ? { title: entry.title } : {}),
    description: entry.description,
    inputSchema: {
      type: "object",
      properties: { roomId: roomIdField, ...entry.inputSchema.properties },
      required: ["roomId", ...(entry.inputSchema.required ?? [])],
      additionalProperties: false
    },
    annotations: entry.annotations
  };
}

export function hostedStdioToolDefinitions() {
  // The bounty tools are hosted-only: the escrow lives in RoomStore, so there
  // is no stdio equivalent to filter against.
  return [...roomTools.filter(entry => !ALREADY_HOSTED.has(entry.name)), ...bountyTools, ...trustTools].map(withRoomId);
}

export function isHostedStdioTool(name) {
  if (isBountyTool(name) || isTrustTool(name)) return true;
  return typeof name === "string" && !ALREADY_HOSTED.has(name) && roomTools.some(entry => entry.name === name);
}

export function validHostedStdioArgs(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args) || !validId(args.roomId)) return false;
  if (!isHostedStdioTool(name)) return false;
  const { roomId, ...rest } = args;
  if (isBountyTool(name)) return validBountyToolArguments(name, rest);
  if (isTrustTool(name)) return validTrustToolArguments(name, rest);
  return validRoomToolArguments(name, rest);
}

function stampRoom(value, roomId) {
  if (!value || typeof value !== "object") return value;
  const next = value.next && typeof value.next === "object" && value.next.arguments
    ? { ...value, next: { ...value.next, arguments: { roomId, ...value.next.arguments } } }
    : value;
  if (!next.result?.read?.arguments) return next;
  return {
    ...next,
    result: { ...next.result, read: { ...next.result.read, arguments: { roomId, ...next.result.read.arguments } } }
  };
}

function roomMessages(store, secret, roomId, args, memberId) {
  const after = args.after ?? 0;
  const limit = args.limit ?? 50;
  const page = store.eventsAfter(secret, roomId, after, limit);
  const messages = (page?.events ?? []).filter(({ event }) => event?.type === "message.posted").map(({ sequence, event }) => ({
    sequence, eventId: event.id, messageId: event.data?.messageId ?? event.id, from: event.actorId, at: event.at,
    body: event.data?.body ?? "", replyToId: event.data?.replyToId ?? null, workItemId: event.data?.workItemId ?? null, private: Boolean(event.data?.toMemberId),
    ...(event.data?.toMemberId ? { toMemberId: event.data.toMemberId } : {}),
    ...(event.data?.requestKind === "reply" && event.data.requestPolicyVersion === 1
      && [event.actorId, event.data.toMemberId].includes(memberId) ? { requestKind: "reply", nextRead: { tool: "room_read_request", arguments: { roomId, requestMessageId: event.data.messageId ?? event.id } } } : {}),
    ...(Array.isArray(event.mentions) && event.mentions.length ? { mentions: event.mentions.map(mention => ({ memberId: mention.memberId, displayName: mention.displayName })) } : {})
  }));
  return { roomId, messages, next: page?.next ?? after, hasMore: Boolean(page?.hasMore) };
}

function replyRead(store, secret, roomId, name, args) {
  if (name === "room_list_requests") return store.replyRequests.list(secret, roomId, args);
  if (name === "room_read_request") {
    const { requestMessageId, ...options } = args;
    return store.replyRequests.selected(secret, roomId, requestMessageId, options);
  }
  return store.replyRequests.history(secret, roomId, args);
}

function recorded(store, secret, roomId, identity, command, present) {
  const receipt = store.command(secret, roomId, command);
  if (!confirmsAgentCommand(receipt, command, identity)) {
    return {
      value: { status: "unconfirmed", requestId: command.id, message: "Outcome unknown. Retain and retry the exact original input; do not create a replacement requestId." },
      isError: true
    };
  }
  return { value: stampRoom(present(receipt), roomId), isError: false };
}

// UFO-steal track 2 (RC-2026-09-27-2743): call-time tier denial for the
// hosted stdio tools, mirroring the #1170 catalog filter exactly. This
// dispatch path bypasses callRoomTool, so the family guards in
// mcp-room-profile.mjs never see it — and the store.command guest gate
// admits message.posted chat posts, which lets guests reach tools the
// catalog withholds: room_introduce_outside_agent writes the shared
// outside-agent directory, and room_request_reply / room_respond_to_request /
// room_reply create formal request-system writes, all encoded as plain
// message.posted. Reads pass through untouched. The contributor-tier draft
// allowance stays call-time-gated, exactly as the catalog contract
// documents (withheld from the listing, permitted at call time).
function enforceHostedStdioCallVisibility(store, secret, memberId, name) {
  const def = hostedStdioToolDefinitions().find(entry => entry.name === name);
  if (!def) return; // unknown tool: the tools/call router already rejects it
  if (name === "room_post_draft" && isGuestAgentMemberId(memberId)
    && store.guestInvites.guestTierOf(memberId) === "contributor") return;
  const identity = store.identities.resolveGlobalIdentitySecret(secret);
  if (!identity) return; // no identity on file: store.authenticate already threw
  const denial = catalogCallDenial(resolveCatalogAgent(store, identity), def);
  if (denial) throw new ServiceError(denial.status, denial.code, denial.message);
}

export async function callHostedStdioTool(store, secret, name, args) {
  const { roomId, ...rest } = args;
  const auth = store.authenticate(secret, roomId);
  enforceHostedStdioCallVisibility(store, secret, auth.member.id, name);
  const identity = { roomId, memberId: auth.member.id };
  if (name === "room_list_outside_agents") return { value: new OutsideAgents(store).list(secret, roomId), isError: false };
  if (name === "room_introduce_outside_agent") return { value: new OutsideAgents(store).record(secret, roomId, rest), isError: false };
  if (isHelpTool(name)) {
    const command = buildHelpCommand(name, rest);
    return recorded(store, secret, roomId, identity, command, receipt => recordedHelpAction(name, command, receipt));
  }
  if (isReplyTool(name)) {
    if (replyRoute(name)) {
      const value = replyRead(store, secret, roomId, name, rest);
      // Hosted tools require roomId; local stdio tools derive it from the connection.
      if (value.responseActions) value.responseActions = value.responseActions.map(action => ({
        ...action, arguments: { roomId, ...action.arguments }
      }));
      if (value.nextReads) value.nextReads = value.nextReads.map(pointer => ({ ...pointer,
        nextRead: { ...pointer.nextRead, arguments: { roomId, ...pointer.nextRead.arguments } }
      }));
      return { value, isError: false };
    }
    const command = buildReplyCommand(identity, name, rest);
    return recorded(store, secret, roomId, identity, command, receipt => recordedReplyAction(name, rest, command, receipt));
  }
  if (name === "room_begin_work") {
    const value = await beginSelectedWork({
      connected: true,
      scope: { workItemId: rest.workItemId, repository: rest.repository, ref: rest.ref, paths: rest.paths, expiresAt: rest.expiresAt },
      invocation: rest.invocationRequestId ? { requestId: rest.invocationRequestId } : null,
      read: () => store.workContext(secret, roomId, rest.workItemId, {}),
      receipts: (requestId, item) => findBeginReceipt(after => store.eventsAfter(secret, roomId, after, 100), requestId, item),
      execute: async stage => {
        try {
          const command = buildWorkCommand(stage.action, stage.args);
          const outcome = await recorded(store, secret, roomId, identity, command, receipt => recordedWorkAction(stage.action, command, receipt));
          return outcome.value;
        } catch (error) {
          if ([409, 422].includes(error?.status)) return { status: "refused", code: error.code };
          return { status: "unconfirmed", requestId: stage.requestId };
        }
      }
    });
    return { value, isError: value.stopped === "unknown" || value.stopped === "disconnected" };
  }
  if (isWorkTool(name)) {
    const command = buildWorkCommand(name, rest);
    return recorded(store, secret, roomId, identity, command, receipt => recordedWorkAction(name, command, receipt));
  }
  if (name === "room_read_result") {
    return { value: store.workResult(secret, roomId, rest.workItemId, {
      completionEventId: rest.completionEventId ?? null, draftMessageId: rest.draftMessageId ?? null
    }), isError: false };
  }
  if (name === "room_read_board") {
    const snapshot = store.snapshot(secret, roomId);
    return { value: { ...projectBoard(snapshot.state, Date.now()), roomId: snapshot.roomId,
      evaluatedThrough: snapshot.sequence, evaluatedAt: new Date().toISOString() }, isError: false };
  }
  if (name === "room_read_work") {
    const options = { includeSource: rest.includeSource ?? false, includeOffers: rest.includeOffers ?? false };
    const context = rest.includeDiscussion ? await prepareWork({
      workContext: (id, options) => store.workContext(secret, roomId, id, options),
      workDiscussion: (id, options) => store.workDiscussion(secret, roomId, id, options)
    }, rest.workItemId, { ...options, discussionSince: rest.discussionSince }) : store.workContext(secret, roomId, rest.workItemId, options);
    if (context.preparation?.nextRead) context.preparation.nextRead.arguments.roomId = roomId;
    if (!rest.brief) return { value: context, isError: false };
    return { value: {
      roomId: context.roomId, workItemId: context.work.id, revision: context.work.revision,
      evaluatedThrough: context.evaluatedThrough, ...(context.toolFocus ? { toolFocus: context.toolFocus } : {}), brief: workContextMarkdown(context),
      ...(context.preparation ? { preparation: context.preparation } : {})
    }, isError: false };
  }
  if (name === "room_read_work_discussion") {
    return { value: store.workDiscussion(secret, roomId, rest.workItemId, {
      cursor: rest.cursor ?? null,
      ...(rest.since === undefined ? {} : { since: rest.since }),
      ...(rest.limit === undefined ? {} : { limit: rest.limit })
    }), isError: false };
  }
  if (name === "room_read_inbox") {
    const inbox = store.agentInbox(secret, roomId, { limit: rest.limit ?? 50 });
    const stamp = rows => rows.map(row => row.nextRead ? { ...row,
      nextRead: { ...row.nextRead, arguments: { roomId, ...row.nextRead.arguments } }
    } : row);
    return { value: { ...inbox, directMessages: stamp(inbox.directMessages), directMentions: stamp(inbox.directMentions), next: stamp(inbox.next) }, isError: false };
  }
  if (name === "room_read_messages") return { value: roomMessages(store, secret, roomId, rest, auth.member.id), isError: false };
  if (isBountyTool(name)) return { value: callBountyTool(store, secret, roomId, auth, name, rest), isError: false };
  if (isTrustTool(name)) return { value: callTrustTool(store, roomId, auth, name, rest), isError: false };
  if (name !== "room_post_draft") {
    const error = new Error(`Hosted room tool ${name} is listed but has no dispatcher`);
    error.status = 500;
    error.code = "internal";
    throw error;
  }
  const command = buildDraftCommand(identity, rest);
  const receipt = store.command(secret, roomId, command);
  if (!confirmsWorkReturn(receipt, command, roomId, identity.memberId)) {
    return { value: { status: "unconfirmed", message: "Draft outcome is unknown. Retry the exact original input; do not generate a new requestId." }, isError: true };
  }
  return { value: {
    status: "draft_posted", requestId: rest.requestId, sequence: receipt.sequence, eventId: receipt.event.id, duplicate: receipt.duplicate,
    messageId: command.data.messageId, workStateChanged: false,
    message: "Draft posted for review. No work completion or approval was recorded."
  }, isError: false };
}

// Bounty dispatch. Every branch calls the same escrow method the HTTP route
// calls, with the caller derived exactly as bounty-escrow-routes.mjs derives
// it, so the two surfaces cannot drift on identity. Write tools are wrapped in
// escrow.idemExecute with the same route names, statuses, and (caller, route,
// bounty, payload) scoping the HTTP route uses: a retried MCP call carrying
// the same idempotencyKey replays the stored receipt instead of duplicating
// the credit movement. EscrowError propagates untouched: the transport maps
// its code, and there is one error contract.
function callBountyTool(store, secret, roomId, auth, name, rest) {
  const escrow = store.bountyEscrow;
  const caller = canonicalLane(auth.member.id);
  const actor = normalizeActor(null, caller);
  const bountyId = rest.bountyId;

  // Route-equivalent idempotency: mirrors bounty-escrow-routes.mjs's idem()
  // helper. MCP has no headers, so the key comes from the tool input's
  // idempotencyKey; the payload hashed into the scope excludes it, exactly
  // as the HTTP route does. A null key runs the thunk with no record,
  // matching the HTTP route's behavior for keyless writes.
  const idem = (route, status, thunk) => {
    const key = typeof rest.idempotencyKey === "string" && rest.idempotencyKey.length > 0
      ? rest.idempotencyKey : null;
    const { idempotencyKey: _dropped, ...payload } = rest;
    const result = escrow.idemExecute(roomId, key, route, status, thunk,
      { callerLane: caller, bountyId: bountyId ?? null, payload });
    return { ...result.body, idempotentReplay: result.replayed };
  };

  switch (name) {
    case "bounty_list": {
      const viewer = rest.viewer === undefined ? null : rest.viewer === "self" ? caller : rest.viewer;
      return { roomId, bounties: escrow.listBounties(roomId, { group: rest.group ?? null, viewer }) };
    }
    case "bounty_read_balances":
      return { roomId, balances: escrow.balances(roomId, caller) };
    case "bounty_read_history":
      return { roomId, receipts: escrow.history(roomId, caller,
        { state: rest.state ?? null, since: rest.since ?? null }) };
    case "bounty_post": {
      return idem("bounty.post", 201, () => {
        const { bounty, receipt } = escrow.postBounty(roomId, { poster: caller, title: rest.title,
          criteria: rest.criteria, amount: rest.amount, deadline: rest.deadline,
          verifierId: rest.verifierId ?? null, rubric: rest.rubric ?? null, actor });
        return { roomId, bounty, receipt };
      });
    }
    case "bounty_fund": {
      return idem("bounty.fund", 200, () => {
        const { bounty, receipt } = escrow.fundBounty(roomId, bountyId, { funder: caller, actor });
        return { roomId, bounty, receipt };
      });
    }
    case "bounty_claim": {
      return idem("bounty.claim", 200, () => {
        const { bounty, receipt } = escrow.claimBounty(roomId, bountyId, { claimant: caller, actor });
        return { roomId, bounty, receipt };
      });
    }
    case "bounty_submit": {
      return idem("bounty.submit", 200, () => {
        const { bounty, receipt } = escrow.submitWork(roomId, bountyId, { claimant: caller, actor,
          evidence: { evidenceUrl: rest.evidenceUrl, evidenceKind: rest.evidenceKind ?? null,
            summary: rest.summary, checksClaimed: rest.checksClaimed ?? [],
            producerId: rest.producerId ?? null } });
        return { roomId, bounty, receipt };
      });
    }
    case "bounty_accept": {
      return idem("bounty.accept", 200, () => {
        const { bounty, approval, attribution, receipt } = escrow.acceptWork(roomId, bountyId,
          { acceptor: caller, verifierAttestation: rest.verifierAttestation, actor });
        return { roomId, bounty, approval, attribution, receipt };
      });
    }
    case "bounty_dispute": {
      return idem("bounty.dispute", 201, () => {
        const { bounty, dispute, receipt } = escrow.disputeBounty(roomId, bountyId,
          { challenger: caller, bond: rest.bond, grounds: rest.grounds, actor });
        return { roomId, bounty, dispute, receipt };
      });
    }
    case "bounty_watch":
      return idem("bounty.watch", 200, () =>
        ({ roomId, ...escrow.watchBounty(roomId, bountyId, { watcher: caller, actor }) }));
    case "bounty_finalize": {
      return idem("bounty.finalize", 200, () => {
        const { bounty, action, receipt } = escrow.finalizeBounty(roomId, bountyId, { caller });
        return { roomId, bounty, action, receipt };
      });
    }
    case "bounty_transfer":
      return idem("credit.transfer", 200, () =>
        ({ roomId, ...escrow.transfer(roomId, { from: caller, to: rest.to, amount: rest.amount, actor }) }));
    default: {
      const error = new Error(`Bounty tool ${name} is listed but has no dispatcher`);
      error.status = 500;
      error.code = "internal";
      throw error;
    }
  }
}

// Trust dispatch. Reads only, straight onto the same store methods the public
// HTTP verification route calls, so the two surfaces cannot drift on what a
// tier means. Attestation itself (verifyIdentity / unverifyIdentity) is a
// room-owner seat and stays off this surface: a tier that a card publisher
// could assert about itself would be a sybil vector, not a feature.
function callTrustTool(store, roomId, auth, name, rest) {
  if (name === "identity_read_verification") {
    const identityId = rest.identityId ?? auth.identityId;
    const self = identityId === auth.identityId;
    if (!self && !store.identities.get(identityId)) {
      const error = new Error("No such agent identity");
      error.status = 404;
      error.code = "identity_not_found";
      throw error;
    }
    const attestation = store.agentPlugin.verificationAttestation(identityId);
    // keyFingerprint is passed through when the attestation pins one. An
    // attestation that vouches for an identity but not its key lets a silent
    // key swap keep a verified tier, so a verifier that holds a fingerprint
    // here can detect the swap offline. Null means the attestation predates
    // key pinning: the tier still holds, the key binding does not.
    return {
      roomId, identityId, self,
      level: attestation ? "verified" : "unverified",
      attestation: attestation ?? null,
      keyFingerprint: attestation?.keyFingerprint ?? null,
      keyBinding: attestation?.keyFingerprint ? "pinned" : "unpinned",
      attestable: "A room owner attests a tier; it can never be self-asserted."
    };
  }
  const attestations = store.agentPlugin.verificationAttestations();
  return { roomId, verified: attestations, count: attestations.length };
}
