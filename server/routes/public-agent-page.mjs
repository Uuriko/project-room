// Public agent page routes. New routes live in the route table. The flag
// defaults off: public reads answer 404 agent_page_unavailable (the route
// is served, the page is not), and owner routes answer 404 not_found.
import { agentPageHtml, agentPageText, askPollText, AGENT_PAGE_CSP } from "../public-agent-page.mjs";

function originOf(ctx) {
  return ctx.expectedOrigin();
}

function publicOff(ctx) {
  if (!ctx.publicAgentPages) ctx.reject(404, "agent_page_unavailable", "This agent page is off.");
}

function managementOff(ctx) {
  if (!ctx.publicAgentPages) ctx.reject(404, "not_found", "Not found");
}

function wants(req, type) {
  const accept = String(req.headers.accept || "");
  if (!accept || accept.includes("text/html") || accept.includes("*/*")) return false;
  return accept.includes(type);
}

function roomActor(ctx, write) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Browser session required");
  // Auth first: an unauthenticated mutating room route must be 401/403.
  // Flag off still hides the page from a signed-in owner as not_found.
  managementOff(ctx);
  ctx.rate(`read:${auth.credentialHash}`, 600);
  if (write) {
    ctx.protectWrite(ctx.req, auth, selected.bearer);
    ctx.rate(`write:${auth.credentialHash}`, 60);
  }
  if (auth.kind === "api-key") {
    const requiredScope = write ? "rooms:write" : "rooms:read";
    const granted = (auth.apiKeyScopes ?? []).some(scope =>
      scope === requiredScope || (scope.endsWith(":*") && requiredScope.startsWith(scope.slice(0, -1))));
    if (!granted) ctx.reject(403, "insufficient_scope", `API key lacks the ${requiredScope} scope`);
  }
  return { roomId, actorId: auth.member.id };
}

export async function publicAgentPage(ctx) {
  publicOff(ctx);
  ctx.rate(`public-agent:${ctx.remoteAddress}`, 120);
  const card = ctx.store.publicAgentPages.card(ctx.params.slug, originOf(ctx));
  ctx.res.setHeader("X-Robots-Tag", "noindex, nofollow");
  if (wants(ctx.req, "application/json")) return ctx.json(ctx.res, 200, card);
  if (wants(ctx.req, "text/plain")) {
    const text = agentPageText(card);
    ctx.res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
      "X-Robots-Tag": "noindex, nofollow",
    });
    return ctx.res.end(text);
  }
  const html = agentPageHtml(card);
  ctx.res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Content-Security-Policy": AGENT_PAGE_CSP,
    "X-Robots-Tag": "noindex, nofollow",
  });
  return ctx.res.end(html);
}

export async function publicAgentCard(ctx) {
  publicOff(ctx);
  ctx.rate(`public-agent:${ctx.remoteAddress}`, 120);
  ctx.res.setHeader("X-Robots-Tag", "noindex, nofollow");
  return ctx.json(ctx.res, 200, ctx.store.publicAgentPages.card(ctx.params.slug, originOf(ctx)));
}

export async function publicAgentAsk(ctx) {
  publicOff(ctx);
  ctx.rate(`public-ask:${ctx.remoteAddress}`, 10);
  const input = await ctx.body(ctx.req);
  ctx.res.setHeader("X-Robots-Tag", "noindex, nofollow");
  return ctx.json(ctx.res, 202, ctx.store.publicAgentPages.postAsk(ctx.params.slug, input, originOf(ctx), ctx.remoteAddress));
}

export async function publicAgentPoll(ctx) {
  publicOff(ctx);
  ctx.rate(`public-agent:${ctx.remoteAddress}`, 120);
  const ask = ctx.store.publicAgentPages.poll(ctx.params.slug, ctx.params.askId, originOf(ctx));
  ctx.res.setHeader("X-Robots-Tag", "noindex, nofollow");
  if (wants(ctx.req, "text/plain")) {
    const text = askPollText(ask);
    ctx.res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
      "X-Robots-Tag": "noindex, nofollow",
    });
    return ctx.res.end(text);
  }
  return ctx.json(ctx.res, 200, ask);
}

export async function listPublicAgentPages(ctx) {
  const { roomId, actorId } = roomActor(ctx, false);
  return ctx.json(ctx.res, 200, ctx.store.publicAgentPages.list(roomId, actorId, originOf(ctx)));
}

export async function configurePublicAgentPage(ctx) {
  const { roomId, actorId } = roomActor(ctx, true);
  const input = await ctx.body(ctx.req);
  return ctx.json(ctx.res, 200, ctx.store.publicAgentPages.configure(roomId, actorId, ctx.params.memberId, input, originOf(ctx)));
}

export async function listPublicAgentAsks(ctx) {
  const { roomId, actorId } = roomActor(ctx, false);
  return ctx.json(ctx.res, 200, ctx.store.publicAgentPages.asks(roomId, actorId, ctx.params.memberId, originOf(ctx)));
}

export async function actPublicAgentAsk(ctx) {
  const { roomId, actorId } = roomActor(ctx, true);
  const input = await ctx.body(ctx.req);
  return ctx.json(ctx.res, 200, ctx.store.publicAgentPages.act(roomId, actorId, ctx.params.memberId, ctx.params.askId, input, originOf(ctx)));
}

const slugParams = Object.freeze({ type: "object", required: ["slug"], properties: { slug: { type: "string" } } });
const askParams = Object.freeze({ type: "object", required: ["slug", "askId"], properties: { slug: { type: "string" }, askId: { type: "string" } } });
const roomParams = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const memberParams = Object.freeze({ type: "object", required: ["roomId", "memberId"], properties: { roomId: { type: "string" }, memberId: { type: "string" } } });
const actParams = Object.freeze({
  type: "object", required: ["roomId", "memberId", "askId"],
  properties: { roomId: { type: "string" }, memberId: { type: "string" }, askId: { type: "string" } },
});
const pageBody = Object.freeze({
  type: "object", required: ["access", "slug", "blurb", "enabled"],
  properties: { access: { type: "string" }, slug: { type: "string" }, blurb: { type: "string" }, enabled: { type: "boolean" } },
});
const askBody = Object.freeze({
  type: "object", required: ["question"],
  properties: { question: { type: "string" }, from: { type: "string" } },
});
const actBody = Object.freeze({
  type: "object", required: ["action"],
  properties: { action: { type: "string" }, answer: { type: "string" } },
});
const objectResponse = Object.freeze({ response: { type: "object" } });
const publicParity = "exempt:visiting agents ask through this public page; no room MCP tool posts or reads another agent's public asks";
const publicPublication = "open:opt-in public agent page behind the agent-pages flag; serves the agent's public card only, no room data";
const ownerParity = "exempt:the owner manages this page in the room; no MCP tool publishes an agent page";

export const PUBLIC_AGENT_PAGE_ROUTES = Object.freeze([
  Object.freeze({
    id: "public-agent-page", method: "GET", path: "/u/{slug}", auth: "none", capability: null,
    scope: "public", handler: publicAgentPage, parity: publicParity, publication: publicPublication,
    schema: { params: slugParams, ...objectResponse }, events: [],
  }),
  Object.freeze({
    id: "public-agent-card", method: "GET", path: "/api/public/agents/{slug}", auth: "none", capability: null,
    scope: "public", handler: publicAgentCard, parity: publicParity, publication: publicPublication,
    schema: { params: slugParams, ...objectResponse }, events: [],
  }),
  Object.freeze({
    id: "public-agent-ask", method: "POST", path: "/api/public/agents/{slug}/asks", auth: "none", capability: null,
    scope: "public", handler: publicAgentAsk, parity: publicParity, publication: publicPublication,
    schema: { params: slugParams, body: askBody, ...objectResponse }, events: [],
  }),
  Object.freeze({
    id: "public-agent-poll", method: "GET", path: "/api/public/agents/{slug}/asks/{askId}", auth: "none", capability: null,
    scope: "public", handler: publicAgentPoll, parity: publicParity, publication: publicPublication,
    schema: { params: askParams, ...objectResponse }, events: [],
  }),
  Object.freeze({
    id: "public-agent-list", method: "GET", path: "/api/rooms/{roomId}/public-agent", auth: "room", capability: null,
    scope: "room", handler: listPublicAgentPages, parity: ownerParity,
    schema: { params: roomParams, ...objectResponse }, events: [],
  }),
  Object.freeze({
    id: "public-agent-configure", method: "POST", path: "/api/rooms/{roomId}/public-agent/{memberId}", auth: "room", capability: null,
    scope: "room", handler: configurePublicAgentPage, parity: ownerParity,
    schema: { params: memberParams, body: pageBody, ...objectResponse }, events: [],
  }),
  Object.freeze({
    id: "public-agent-asks", method: "GET", path: "/api/rooms/{roomId}/public-agent/{memberId}/asks", auth: "room", capability: null,
    scope: "room", handler: listPublicAgentAsks, parity: ownerParity,
    schema: { params: memberParams, ...objectResponse }, events: [],
  }),
  Object.freeze({
    id: "public-agent-act", method: "POST", path: "/api/rooms/{roomId}/public-agent/{memberId}/asks/{askId}", auth: "room", capability: null,
    scope: "room", handler: actPublicAgentAsk, parity: ownerParity,
    schema: { params: actParams, body: actBody, ...objectResponse }, events: [],
  }),
]);
