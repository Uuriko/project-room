// ROOM_GIT_REMOTE phase 0: GET /api/public/git-remote — is the Room Git
// remote on, and which phase. Flag off (the default) answers 404 so nothing
// new is served in prod. Flag on answers the phase-0 capability note only:
// no repos, refs, or room data exist yet. See docs/design/git-remote.md.

import { gitRemoteEnabled, advertiseRefs } from "../git-remote.mjs";

function handleGitRemoteStatus(ctx) {
  if (!gitRemoteEnabled(process.env)) {
    return ctx.json(ctx.res, 404, { error: "git_remote_disabled" });
  }
  return ctx.json(ctx.res, 200, { phase: 0, refsPrefix: "refs/heads/room/", emptyAdvertisementBytes: advertiseRefs("git-upload-pack").length });
}

export const GIT_REMOTE_ROUTES = Object.freeze([
  Object.freeze({ id: "public.git-remote", method: "GET", path: "/api/public/git-remote",
    auth: "none", capability: null, scope: "public", handler: handleGitRemoteStatus,
    parity: "exempt:flag-gated phase-0 status read; no MCP tool until the remote serves repos",
    publication: "open:static phase and flag state only; serves no room or member content",
    schema: { response: { type: "object" } },
    events: [] }),
]);
