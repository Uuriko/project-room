// Phase 2 B1 + C1: static pitch pages served from the route table.
//   GET/HEAD /for            /for/{slug}   one page per agent
//   GET/HEAD /vs             /vs/{slug}    one page per alternative
//   GET/HEAD /starters       /starters.json  room-starter prompt library
// Script-free HTML (cream, plum, one accent), same bytes for every caller,
// no room data, no credential. Content lives in the *-data.mjs files.
import { FOR_AGENTS, VS_COMPETITORS, PROMISE, SETUP_PASTE } from "../pitch-pages-data.mjs";
import { STARTERS } from "../starters-data.mjs";
import { PUBLIC_SEARCH_CSP, publicPageCsp } from "../public-search.mjs";

const ORIGIN = "https://room.trydemigod.com";
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const CSS = "body{margin:0;background:#FBF6EE;color:#3B1F3A;font:17px/1.6 Inter,system-ui,sans-serif}"
  + "main{max-width:760px;margin:0 auto;padding:56px 24px 80px}h1{font-size:40px;line-height:1.15;margin:0 0 16px}"
  + "h2{font-size:22px;margin:40px 0 12px}a{color:#3B1F3A}.accent{color:#D9502B}.promise{font-size:20px;margin:0 0 32px}"
  + "ol,ul{padding-left:22px}li{margin:6px 0}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:10px 8px;border-top:1px solid #E6DCCB}"
  + "pre{white-space:pre-wrap;background:#fff;border:2px solid #D9502B;border-radius:12px;padding:16px;font-size:15px}"
  + ".cta{display:inline-block;background:#D9502B;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:600}"
  + "nav{font-size:15px;margin-bottom:40px}nav a{margin-right:16px}.card{background:#fff;border-radius:16px;padding:20px;margin:16px 0}";

function page({ title, description, path, body }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${ORIGIN}${path}">`
    + `<link rel="icon" href="/favicon.svg"><style>${CSS}</style></head><body><main>`
    + `<nav><a href="/">Project Room</a><a href="/for">For your agent</a><a href="/vs">Compare</a><a href="/starters">Starters</a><a href="/demo">Live demo</a></nav>`
    + body
    + `<h2>Copy setup for your AI</h2><p>Paste this into your agent, with the invite code from your room:</p><pre>${esc(SETUP_PASTE)}</pre>`
    + `<p><a class="cta" href="/demo">See a live room</a></p></main></body></html>`;
}

const list = items => `<ul>${items.map(i => `<li>${esc(i)}</li>`).join("")}</ul>`;

export function forPage(slug) {
  const a = FOR_AGENTS[slug];
  if (!Object.hasOwn(FOR_AGENTS, slug)) return null;
  return page({ title: `Project Room for ${a.name}`, description: a.lead, path: `/for/${slug}`,
    body: `<h1>Project Room for <span class="accent">${esc(a.name)}</span></h1><p class="promise">${esc(a.lead)}</p>${list(a.points)}`
      + `<h2>Set up in three steps</h2><ol><li>Create a room and invite an agent.</li><li>Paste the setup line below into ${esc(a.name)}.</li><li>${esc(a.name)} says hello in the room and starts on the ready work.</li></ol>`
      + `<p>Full setup guide: <a href="${esc(a.docs)}">${esc(a.name)} setup</a>.</p><p>${esc(PROMISE)}</p>` });
}

export function vsPage(slug) {
  if (!Object.hasOwn(VS_COMPETITORS, slug)) return null;
  const c = VS_COMPETITORS[slug];
  const rows = c.rows.map(([k, us, them]) => `<tr><th>${esc(k)}</th><td>${esc(us)}</td><td>${esc(them)}</td></tr>`).join("");
  return page({ title: `Project Room vs ${c.name}`, description: c.lead, path: `/vs/${slug}`,
    body: `<h1>Project Room vs <span class="accent">${esc(c.name)}</span></h1><p class="promise">${esc(c.lead)}</p>`
      + `<table><thead><tr><th></th><th>Project Room</th><th>${esc(c.name)}</th></tr></thead><tbody>${rows}</tbody></table>`
      + `<h2>The promise</h2><p>${esc(PROMISE)}</p>` });
}

export function indexPage(kind) {
  const isFor = kind === "for";
  const src = isFor ? FOR_AGENTS : VS_COMPETITORS;
  const links = Object.entries(src).map(([slug, v]) => `<li><a href="/${kind}/${slug}">${isFor ? `Project Room for ${esc(v.name)}` : `Project Room vs ${esc(v.name)}`}</a></li>`).join("");
  return page({ title: isFor ? "Project Room for your agent" : "Compare Project Room", description: PROMISE, path: `/${kind}`,
    body: `<h1>${isFor ? "Bring the agent you already use" : "How Project Room compares"}</h1><p class="promise">${esc(PROMISE)}</p><ul>${links}</ul>` });
}

export function startersPage() {
  const cards = STARTERS.map(s => `<div class="card" id="${esc(s.id)}"><h2>${esc(s.title)}</h2><p>In the room: ${esc(s.who)}</p><pre>${esc(s.prompt)}</pre></div>`).join("");
  return page({ title: "Room starters: prompts to open a Project Room", description: "Opening prompts for rooms where people and agents ship together.", path: "/starters",
    body: `<h1>Room <span class="accent">starters</span></h1><p class="promise">Open a room, invite your agents, paste one of these. ${esc(PROMISE)}</p>${cards}` });
}

export const startersJson = () => ({ schema: "project-room-starters/1", promise: PROMISE, starters: STARTERS });

function send(ctx, status, type, text) {
  const bytes = Buffer.from(text);
  ctx.res.setHeader("Cache-Control", "public, max-age=300");
  if (type.startsWith("text/html")) ctx.res.setHeader("Content-Security-Policy", publicPageCsp(ctx.expectedOrigin(), PUBLIC_SEARCH_CSP));
  ctx.res.writeHead(status, { "Content-Type": type, "Content-Length": bytes.length });
  return ctx.res.end(ctx.req.method === "HEAD" ? undefined : bytes);
}

const NOT_FOUND = page({ title: "Page not found", description: PROMISE, path: "/for", body: "<h1>That page does not exist</h1><p>Pick your agent or a comparison from the links above.</p>" });

function htmlRoute(render) {
  return ctx => {
    ctx.rate(`acquisition:${ctx.remoteAddress}`, 120);
    const html = render(ctx.params ?? {});
    return html ? send(ctx, 200, "text/html; charset=utf-8", html) : send(ctx, 404, "text/html; charset=utf-8", NOT_FOUND);
  };
}

function startersJsonRoute(ctx) {
  ctx.rate(`acquisition:${ctx.remoteAddress}`, 120);
  return send(ctx, 200, "application/json; charset=utf-8", JSON.stringify(startersJson()));
}

const SPECS = [
  ["for-index", "/for", htmlRoute(() => indexPage("for"))],
  ["for-page", "/for/{slug}", htmlRoute(p => forPage(p.slug))],
  ["vs-index", "/vs", htmlRoute(() => indexPage("vs"))],
  ["vs-page", "/vs/{slug}", htmlRoute(p => vsPage(p.slug))],
  ["starters", "/starters", htmlRoute(() => startersPage())],
  ["starters-json", "/starters.json", startersJsonRoute],
];

export const PITCH_PAGE_ROUTES = Object.freeze(SPECS.flatMap(([id, path, handler]) => ["GET", "HEAD"].map(method => Object.freeze({
  id: `${id}-${method.toLowerCase()}`, method, path, parity: "exempt:static public HTML/JSON pitch page; no MCP equivalent",
  auth: "none", capability: null, scope: "public", handler,
  schema: path.includes("{slug}")
    ? { params: { type: "object", required: ["slug"], properties: { slug: { type: "string" } } }, response: { type: "string" } }
    : { response: { type: path.endsWith(".json") ? "object" : "string" } },
  events: [] }))));
