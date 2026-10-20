// Room read guard for derived read-only views (claim map, work-ready,
// catch-up card). Mirrors the room read authorization chain used by the
// digest and work-claims-read routes: room bearer or browser session, the
// rooms:read API-key scope, the read rate bucket, and active membership.
export function authenticateRoomRead(ctx) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Browser session required");
  ctx.rate(`read:${auth.credentialHash}`, 600);
  if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(scope => scope === "rooms:read" || scope === "rooms:*")) {
    ctx.reject(403, "insufficient_scope", "API key lacks the rooms:read scope");
  }
  const member = (ctx.store.roomAuthority(roomId).members ?? {})[auth.member.id];
  if (!member || member.active === false) ctx.reject(403, "not_member", `Member "${auth.member.id}" is not a member of room "${roomId}"`);
  return { roomId, auth, selected, fence };
}
