// Hosted MCP full profile: the local stdio room tools, on the same URL as
// the public join tools, behind Authorization: Bearer pri_….
//
// Each tool takes roomId because one identity secret can belong to many
// rooms. Reads call the store methods the HTTP agent routes already use.
// Writes call the same command builders as stdio, then RoomStore.command.
// Local attention tools stay off this URL: they read an operator directory.

import { prepareWork } from "../client/work-preparation.mjs";
import { beginSelectedWork } from "../client/begin-work.mjs";
import { validId } from "../src/events.js";
import { projectBoard } from "../src/board.js";
import { confirmsWorkReturn } from "../src/workflow.js";
import { workContextMarkdown } from "../client/room-agent.mjs";
import { roomTools, validRoomToolArguments, buildDraftCommand } from "../client/mcp-stdio.mjs";
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
  return roomTools.filter(entry => !ALREADY_HOSTED.has(entry.name)).map(withRoomId);
}

export function isHostedStdioTool(name) {
  return typeof name === "string" && !ALREADY_HOSTED.has(name) && roomTools.some(entry => entry.name === name);
}

export function validHostedStdioArgs(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args) || !validId(args.roomId)) return false;
  if (!isHostedStdioTool(name)) return false;
  const { roomId, ...rest } = args;
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

function roomMessages(store, secret, roomId, args) {
  const after = args.after ?? 0;
  const limit = args.limit ?? 50;
  const page = store.eventsAfter(secret, roomId, after, limit);
  const messages = (page?.events ?? []).filter(({ event }) => event?.type === "message.posted").map(({ sequence, event }) => ({
    sequence, eventId: event.id, messageId: event.data?.messageId ?? event.id, from: event.actorId, at: event.at,
    body: event.data?.body ?? "", replyToId: event.data?.replyToId ?? null, private: Boolean(event.data?.toMemberId),
    ...(event.data?.toMemberId ? { toMemberId: event.data.toMemberId } : {}),
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

export async function callHostedStdioTool(store, secret, name, args) {
  const { roomId, ...rest } = args;
  const auth = store.authenticate(secret, roomId);
  const identity = { roomId, memberId: auth.member.id };
  if (isHelpTool(name)) {
    const command = buildHelpCommand(name, rest);
    return recorded(store, secret, roomId, identity, command, receipt => recordedHelpAction(name, command, receipt));
  }
  if (isReplyTool(name)) {
    if (replyRoute(name)) return { value: replyRead(store, secret, roomId, name, rest), isError: false };
    const command = buildReplyCommand(identity, name, rest);
    return recorded(store, secret, roomId, identity, command, receipt => recordedReplyAction(name, rest, command, receipt));
  }
  if (name === "room_begin_work") {
    const value = await beginSelectedWork({
      connected: true,
      scope: { workItemId: rest.workItemId, repository: rest.repository, ref: rest.ref, paths: rest.paths, expiresAt: rest.expiresAt },
      read: () => store.workContext(secret, roomId, rest.workItemId, {}),
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
      evaluatedThrough: context.evaluatedThrough, brief: workContextMarkdown(context),
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
    return { value: store.agentInbox(secret, roomId, { limit: rest.limit ?? 50 }), isError: false };
  }
  if (name === "room_read_messages") return { value: roomMessages(store, secret, roomId, rest), isError: false };
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
