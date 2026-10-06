// Typing-indicator heartbeat route (human UX batch).
//
// POST /api/rooms/{roomId}/typing records an ephemeral heartbeat; the beat
// expires server-side after TYPING_TTL_MS with no explicit stop. Beats are
// never persisted and never enter the event log. Viewers learn about typists
// via synthetic `typing` events on the SSE stream (no `id:`, so Last-Event-ID
// resume cursors are untouched).
//
// Auth mirrors the room chain exactly: room credential, fence, roomAuth, then
// a light rate limit so heartbeat spam cannot become a cheap presence oracle.

import { recordBeat, typingBeats, TYPING_TTL_MS } from "../typing.mjs";

export async function postTypingBeat(ctx) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (!auth?.member?.id) ctx.reject(401, "unauthenticated", "Room membership required");
  ctx.rate(`typing:${auth.credentialHash}`, 120);
  recordBeat(typingBeats, roomId, auth.member);
  return ctx.json(ctx.res, 200, { ok: true, ttlMs: TYPING_TTL_MS });
}

const parameters = Object.freeze({ type: "object", required: ["roomId"],
  properties: { roomId: { type: "string" } } });

export const TYPING_ROUTES = Object.freeze([
  Object.freeze({ id: "typing", method: "POST", path: "/api/rooms/{roomId}/typing",
    auth: "room", capability: null, scope: "room", handler: postTypingBeat,
    schema: { params: parameters, response: { type: "object" } },
    events: [] }),
]);
