import { workspaceArtifactSelection } from "../../src/workspace-artifact-link.js";
import { ownMember } from "../../src/events.js";
import { fileLabel, parsePatch } from "../../src/workspace-diff-parser.js";
import { readAccountRoomRow } from "../room-lifecycle.mjs";
import { previewJsonBytes, validatePreviewInput, validPreviewSelection, workspacePreviews } from "../workspace-previews.mjs";

// The frame response supplies its own policy instead of inheriting the Room
// application's style and script restrictions through srcdoc.
const previewPolicy = [
  "sandbox allow-scripts",
  "frame-ancestors 'self'",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

function renderFrame(ctx, item) {
  ctx.res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": previewPolicy,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  ctx.res.end(item.html);
}

function changeResponse(ctx, params, item, viewer) {
  if (params.has("revision") && String(item.revision) !== params.get("revision"))
    ctx.reject(409, "preview_changed", "This preview changed. Open the latest version.");
  const { patch, ...source } = item;
  const view = params.get("view");
  if (view === null) return ctx.json(ctx.res, 200, { ...viewer, changes: item });
  if (patch === null) return ctx.json(ctx.res, 200, { ...viewer, changes: { ...source, status: "not_published" } });
  const files = parsePatch(patch);
  if (!files) return ctx.json(ctx.res, 200, { ...viewer, changes: { ...source, status: "raw_available" } });
  if (view === "file") {
    const path = params.get("path");
    const file = files.find(value => value.oldPath === path || value.newPath === path);
    if (!file) ctx.reject(404, "preview_file_not_found", "This path is absent from the published changes");
    return ctx.json(ctx.res, 200, { ...viewer, changes: { ...source, file } });
  }
  return ctx.json(ctx.res, 200, { ...viewer, changes: { ...source, files: files.map(file => ({
    path: fileLabel(file), type: file.type, hunks: file.hunks.length,
  })) } });
}

function authorize(ctx, place, needed) {
  const { selected, roomId, fence } = place;
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Room credential required");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Browser session required");
  if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(scope => scope === needed || scope === "rooms:*"))
    ctx.reject(403, "insufficient_scope", `API key lacks ${needed}`);
  return auth;
}

async function serveWorkspacePreviews(ctx) {
  const { req, res, store, url } = ctx;
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(req, url);
  const params = url.searchParams, id = params.get("id"), frameRevision = params.get("frame");
  const frame = req.method === "GET" && frameRevision !== null;
  const changeRead = req.method === "GET" && params.has("changes");
  const outputRead = req.method === "GET" && params.has("output");
  const fence = selected.mode === "account" ? ctx.accountBinding(req, frame ? url : null) : ctx.expectedBinding(req);
  const place = { roomId, selected, fence };
  const reading = req.method === "GET";
  const needed = reading ? "rooms:read" : "rooms:write";
  const auth = authorize(ctx, place, needed), viewerId = auth.member.id;
  res.setHeader("Cache-Control", "no-store");
  const exact = changeRead && params.has("artifact") ? workspaceArtifactSelection(params.get("artifact")) : null;
  const allowed = frame ? ["auth", "id", "frame", "binding"]
    : changeRead ? ["auth", "id", "changes", "revision", "view", "path", "artifact"]
      : outputRead ? ["auth", "id", "output", "revision"] : ["auth", "id"];
  if ([...params.keys()].some(name => !allowed.includes(name) || params.getAll(name).length !== 1)
    || id !== null && !validPreviewSelection(id)
    || changeRead && (!id || params.get("changes") !== "1" || params.has("revision") && !/^[1-9][0-9]*$/.test(params.get("revision"))
      || params.has("view") && !["summary", "file"].includes(params.get("view"))
      || params.has("artifact") && (!exact?.head || exact.id !== id || exact.panel !== "changes"
        || params.get("view") === "file" && (exact.file ?? null) !== params.get("path"))
      || (params.get("view") === "file" ? !params.get("path") || params.get("path").length > 4096 : params.has("path")))
    || outputRead && (!id || params.get("output") !== "1" || params.has("revision") && !/^[1-9][0-9]*$/.test(params.get("revision")))
    || frame && (selected.bearer || !id || !/^[1-9][0-9]*$/.test(frameRevision)))
    ctx.reject(422, "invalid_preview", "Choose one preview ID and revision");
  if (reading) {
    ctx.rate(`read:${auth.credentialHash}`, 600);
    const previews = workspacePreviews(store.db, { create: false });
    const viewer = { roomId, viewerId, viewerAccountId: auth.account?.id ?? null, viewerAuthEpoch: auth.account?.authEpoch ?? null,
      viewerSessionBinding: auth.sessionBinding ?? null, viewerSessionRevision: auth.sessionRevision ?? null };
    if (id === null) return ctx.json(res, 200, { ...viewer, items: previews?.list(roomId, viewerId) ?? [] });
    const item = previews?.get(roomId, id, viewerId, changeRead ? "changes" : outputRead ? "output" : undefined);
    if (!item) ctx.reject(404, "preview_not_found", "This preview is unavailable");
    if (exact && (item.revision !== exact.revision || item.head !== exact.head || item.publisherId !== exact.publisherId
      || item.patchDigest !== exact.digest)) ctx.reject(409, "preview_changed", "This preview changed. Open the latest version.");
    const { base, head, revision, patch, output } = item;
    if (changeRead) return changeResponse(ctx, params, { id, base, head, revision, patch }, viewer);
    if (outputRead) {
      if (params.has("revision") && String(item.revision) !== params.get("revision"))
        ctx.reject(409, "preview_changed", "This preview changed. Open the latest version.");
      return ctx.json(res, 200, { ...viewer, run: { id, base, head, revision, output } });
    }
    if (frame) {
      if (String(item.revision) !== frameRevision) ctx.reject(409, "preview_changed", "This preview changed. Open the latest version.");
      return renderFrame(ctx, item);
    }
    const { patch: _patch, output: _output, ...preview } = item;
    return ctx.json(res, 200, { ...viewer, item: preview });
  }

  ctx.protectWrite(req, auth, selected.bearer);
  ctx.rate(`write:${auth.credentialHash}`, 60);
  const removing = req.method === "DELETE", input = await ctx.body(req, { limit: previewJsonBytes });
  if (id !== null || !validatePreviewInput(input, removing)) ctx.reject(422, "invalid_preview", "Choose valid preview fields and a known revision");
  const result = store.transaction(() => {
    const current = authorize(ctx, place, needed);
    if (current.member.id !== viewerId) ctx.reject(403, "access_denied", "The acting identity changed");
    if (!removing) {
      if (readAccountRoomRow(store, roomId)?.archived_at) ctx.reject(409, "room_archived", "This room is archived");
      if (!current.member.permissions.includes("complete_work")) ctx.reject(403, "access_denied", "Publishing a preview requires work access");
      if (input.recipientId) {
        const { members } = store.roomAuthority(roomId, { memberId: input.recipientId });
        const recipient = ownMember(members, input.recipientId);
        if (!recipient || recipient.active === false)
          ctx.reject(422, "preview_recipient_unavailable", "Choose an active member of this room");
      }
    }
    const previews = workspacePreviews(store.db, { create: !removing });
    return removing ? previews?.remove(roomId, viewerId, input, store.roomOwnerId(roomId) === viewerId, ctx.reject) ?? { removed: true }
      : previews.publish(roomId, viewerId, input, Date.now(), ctx.reject);
  });
  const { changed, ...value } = result;
  if (changed) ctx.workspacePreviewChanged?.(roomId, value.recipientId ? [value.publisherId, value.recipientId] : null);
  return ctx.json(res, 200, removing ? { removed: true } : value);
}

export const WORKSPACE_PREVIEW_ROUTES = Object.freeze(["GET", "POST", "DELETE"].map(method => Object.freeze({
  id: `workspace-previews-${method.toLowerCase()}`, method, path: "/api/rooms/{roomId}/workspace-previews",
  auth: "room", scope: "room", capability: null, handler: serveWorkspacePreviews,
  parity: "exempt:CLI transport for bounded room-visible local build previews",
  schema: { params: { type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } },
    response: { type: "object" } },
  events: [],
})));
