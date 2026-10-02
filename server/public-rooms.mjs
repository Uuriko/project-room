// Public acquisition pages: template gallery, opt-in room pages, agent directory.
// Script-free HTML. Member-authored text is escaped on the page and marked
// untrusted on the JSON agents read. Messages, files, private tasks, and
// names that were not opted in never leave the room.
import { publicPage, joinLink, publicName, publicTask, publicReceipts } from "../src/events.js";
import { escapeHtml, RECEIPTS_PAGE_CSP } from "./receipts-page.mjs";
import { collectPublicReceipts } from "./receipts-live.mjs";
import { CONTENT_TRUST } from "./content-trust.mjs";
import { ROOM_ORIGIN } from "../deploy/agent-discovery.mjs";
import { PUBLIC_PAGE_LASTMOD } from "../deploy/public-search.mjs";
import { listRoomTemplates, getRoomTemplate } from "./templates.mjs";
import { isUnpublished } from "./legal-store.mjs";
import { LEGAL_FOOTER_LINKS, reportHref } from "./legal-pages.mjs";

export { RECEIPTS_PAGE_CSP as PUBLIC_PAGE_CSP };

const OG_IMAGE = `${ROOM_ORIGIN}/og/home.png`;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OPEN = new Set(["proposed", "accepted", "working", "blocked"]);

export function publicRef(value) {
  if (typeof value !== "string") return "";
  const ref = value.trim();
  if (!ref || ref.length > 80 || /[\u0000-\u001f\u007f]/.test(ref)) return "";
  return ref;
}

const withRef = (path, ref) => {
  const url = new URL(path, ROOM_ORIGIN);
  const clean = publicRef(ref);
  if (clean) url.searchParams.set("ref", clean);
  return `${url.pathname}${url.search}${url.hash}`;
};

const pageStyle = () => `:root{color-scheme:dark}
body{margin:0;background:#10141a;color:#e8eef6;font:17px/1.55 system-ui,sans-serif}
main{max-width:42rem;margin:0 auto;padding:2rem 1.25rem 3rem}
h1{font-size:clamp(1.6rem,5vw,2.2rem);line-height:1.15;letter-spacing:-.03em}
a{color:#8eb6ff}
.card{border-top:1px solid #2a3340;padding:1rem 0;overflow-wrap:anywhere;word-break:break-word;max-width:100%}
.meta{color:#9aa6b2;font-size:.9rem}
footer{margin-top:2rem;border-top:1px solid #2a3340;padding-top:1rem;color:#9aa6b2}
img,svg,table{max-width:100%}`;

function head({ title, description, path }) {
  const canonical = `${ROOM_ORIGIN}${path}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="content-trust" content="${escapeHtml(CONTENT_TRUST)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${OG_IMAGE}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${OG_IMAGE}">
<style>${pageStyle()}</style>
</head>`;
}

const shell = heading => `<body><header><p><a href="/">Project Room</a>${heading ? ` · ${heading}` : ""}</p></header>`;

function loadRooms(store) {
  const rooms = new Map();
  let rows = [];
  try { rows = store.db.prepare("SELECT id, projection FROM rooms").all(); }
  catch { return rooms; }
  for (const row of rows) {
    try {
      const projection = JSON.parse(row.projection);
      if (projection?.room?.id) rooms.set(row.id, projection);
    } catch { /* skip a row that is not a room projection */ }
  }
  return rooms;
}

function counts(state) {
  const members = Object.values(state?.members ?? {}).filter(member => member && member.active !== false);
  const agents = members.filter(member => member.kind === "agent").length;
  return { humans: members.length - agents, agents };
}

function publicNames(state) {
  return Object.values(state?.members ?? {})
    .filter(member => member && member.active !== false && publicName(member).enabled === true && typeof member.displayName === "string")
    .map(member => member.displayName);
}

function openTasks(state) {
  return Object.values(state?.workItems ?? {})
    .filter(item => item && OPEN.has(item.state) && publicTask(item).enabled === true && typeof item.title === "string")
    .map(item => ({ title: item.title, definitionOfDone: typeof item.definitionOfDone === "string" ? item.definitionOfDone : "" }));
}

function roomReceipts(store, slug, state) {
  const listed = collectPublicReceipts(store).filter(item => item.room?.id === slug);
  if (publicReceipts(state).enabled !== true) return listed.slice(0, 5);
  const seen = new Set(listed.map(item => item.title));
  const extra = [];
  let claims = [];
  try { claims = store.workClaims?.list?.(slug) ?? []; } catch { claims = []; }
  for (const item of claims) {
    if (!item || item.state !== "done" || item.pullRequest?.outcome !== "merged" || typeof item.title !== "string") continue;
    if (seen.has(item.title)) continue;
    seen.add(item.title);
    extra.push({ id: null, title: item.title, at: typeof item.updatedAt === "string" ? item.updatedAt : "" });
  }
  for (const item of Object.values(state?.workItems ?? {})) {
    if (!item || item.state !== "completed" || !item.receipt || typeof item.title !== "string" || seen.has(item.title)) continue;
    seen.add(item.title);
    extra.push({ id: null, title: item.title, at: typeof item.updatedAt === "string" ? item.updatedAt : "" });
  }
  return [...listed, ...extra].slice(0, 5);
}

function requestHref(slug, ref) {
  return withRef(`/?request=${encodeURIComponent(slug)}`, ref);
}

function ownerInvite(store, slug, state) {
  const ownerId = state?.room?.ownerId;
  const member = state?.members?.[ownerId];
  if (!member || member.active === false || !store.shareLinks?.personalInvite) return null;
  let account = null;
  try {
    const binding = store.db.prepare("SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?").get(slug, ownerId);
    if (binding) {
      const row = store.db.prepare("SELECT id, auth_epoch AS authEpoch FROM accounts WHERE id=? AND active=1").get(binding.account_id);
      if (row) account = { id: row.id, authEpoch: row.authEpoch };
    }
  } catch { account = null; }
  try {
    const minted = store.transaction(() => store.shareLinks.personalInvite({ member, account }, slug, 25));
    return minted?.token ? minted.token : null;
  } catch { return null; }
}

export function publicRoomView(store, slug, { ref = "" } = {}) {
  if (!SLUG.test(slug)) return null;
  if (isUnpublished(store.db, "room", slug)) return null;
  const state = loadRooms(store).get(slug);
  if (!state || publicPage(state).enabled !== true) return null;
  const clean = publicRef(ref);
  let join = { mode: "request", href: requestHref(slug, clean) };
  if (joinLink(state).enabled === true) {
    const token = ownerInvite(store, slug, state);
    if (token) join = { mode: "link", href: withRef(`/#join/${token}`, clean) };
  }
  const title = typeof state.room.title === "string" ? state.room.title : slug;
  const purpose = typeof state.room.purpose === "string" ? state.room.purpose : "";
  const memberCounts = counts(state);
  const names = publicNames(state);
  const tasks = openTasks(state);
  const receipts = roomReceipts(store, slug, state).map(item => ({
    id: item.id ?? null,
    title: item.title,
    href: item.id ? `/receipts/${item.id}` : null,
  }));
  const document = {
    schema: "project-room-public-room/1",
    contentTrust: CONTENT_TRUST,
    untrusted: true,
    slug,
    title,
    purpose,
    counts: memberCounts,
    names,
    tasks,
    receipts,
    join,
  };
  const description = purpose || `${title} on Project Room.`;
  const nameLine = names.length ? `<p>People who show their name: ${names.map(escapeHtml).join(", ")}</p>` : "";
  const taskLine = tasks.length
    ? `<ul>${tasks.map(item => `<li>${escapeHtml(item.title)}</li>`).join("")}</ul>`
    : `<p>No open public tasks.</p>`;
  const receiptLine = receipts.length
    ? `<ul>${receipts.map(item => `<li>${item.href ? `<a href="${escapeHtml(item.href)}">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}</li>`).join("")}</ul>`
    : `<p>No public receipts from this room yet.</p>`;
  const html = `${head({ title, description, path: `/r/${slug}` })}
${shell(`<a href="/templates">Templates</a>`)}
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(purpose)}</p>
<p class="meta">${memberCounts.humans} ${memberCounts.humans === 1 ? "person" : "people"} · ${memberCounts.agents} ${memberCounts.agents === 1 ? "agent" : "agents"}</p>
${nameLine}
<h2>Open tasks</h2>
${taskLine}
<h2>Public receipts</h2>
${receiptLine}
<p><a href="${escapeHtml(join.href)}">Join</a></p>
<p><a href="${escapeHtml(reportHref("room", slug))}">Report</a></p>
</main>
<footer><a href="/?start=room">Made in Project Room — start your own room</a><p>${LEGAL_FOOTER_LINKS}</p></footer>
</body></html>`;
  return { html, document };
}

export function templatesIndex() {
  const templates = listRoomTemplates();
  const description = "Start a Project Room from a template: channels, starter tasks, and a board claim with no files yet.";
  const cards = templates.map(template => `<article class="card">
<h2><a href="/templates/${escapeHtml(template.slug)}">${escapeHtml(template.title)}</a></h2>
<p>${escapeHtml(template.purpose)}</p>
</article>`).join("");
  const html = `${head({ title: "Project Room — templates", description, path: "/templates" })}
${shell("")}
<main>
<h1>Templates</h1>
<p>Each template starts a room with a purpose, channels, and a few tasks. Sign in to create it. Your messages stay in the room.</p>
${cards}
</main>
<footer><a href="/agents">Agent directory</a><p>${LEGAL_FOOTER_LINKS}</p></footer>
</body></html>`;
  return {
    html,
    document: { schema: "project-room-template-list/1", templates },
  };
}

export function templatePage(slug, { ref = "" } = {}) {
  const template = getRoomTemplate(slug);
  if (!template) return null;
  const description = template.purpose;
  const start = withRef(`/?start=template&template=${encodeURIComponent(template.slug)}`, ref);
  const tasks = template.tasks.map(item => `<li>${escapeHtml(item.title)}</li>`).join("");
  const html = `${head({ title: template.title, description, path: `/templates/${template.slug}` })}
${shell(`<a href="/templates">Templates</a>`)}
<main>
<h1>${escapeHtml(template.title)}</h1>
<p>${escapeHtml(template.purpose)}</p>
<h2>Starter tasks</h2>
<ul>${tasks}</ul>
<p><a href="${escapeHtml(start)}">Start this room</a></p>
</main>
<footer><a href="/templates">All templates</a><p>${LEGAL_FOOTER_LINKS}</p></footer>
</body></html>`;
  return {
    html,
    document: {
      schema: "project-room-template/1",
      slug: template.slug,
      title: template.title,
      purpose: template.purpose,
      start,
    },
  };
}

function directoryCounts(store, agentId, identityId, publicRooms) {
  const links = identityId
    ? store.db.prepare("SELECT room_id AS roomId, member_id AS memberId FROM identity_links WHERE identity_id=?").all(identityId)
    : [];
  const names = new Set();
  let roomCount = 0;
  for (const link of links) {
    const state = publicRooms.get(link.roomId);
    if (!state || publicPage(state).enabled !== true) continue;
    const member = state.members?.[link.memberId];
    if (!member || member.active === false) continue;
    roomCount += 1;
    if (publicName(member).enabled === true && typeof member.displayName === "string") names.add(member.displayName);
  }
  const receipts = collectPublicReceipts(store);
  const receiptCount = receipts.filter(item => {
    const named = [...(item.agents ?? []), ...(item.humans ?? [])];
    return named.includes(agentId) || (identityId && named.includes(identityId)) || named.some(name => names.has(name));
  }).length;
  return { roomCount, receiptCount };
}

export function agentDirectoryView(store, { ref = "" } = {}) {
  let agents = [];
  try {
    const doc = store.agentPlugin?.publicDirectoryDocument?.({ serviceOrigin: ROOM_ORIGIN });
    agents = Array.isArray(doc?.agents) ? doc.agents : [];
  } catch { agents = []; }
  const rooms = loadRooms(store);
  const cards = agents.filter(agent => agent && agent.visibility === "public").map(agent => {
    let identityId = null;
    try {
      identityId = store.db.prepare("SELECT owner_identity_id AS id FROM agent_directory_cards WHERE agent_id=? AND withdrawn=0").get(agent.agentId)?.id ?? null;
    } catch { identityId = null; }
    const countsFor = directoryCounts(store, agent.agentId, identityId, rooms);
    return {
      agentId: agent.agentId,
      name: agent.name,
      description: agent.description,
      skills: Array.isArray(agent.skills) ? [...agent.skills] : [],
      receiptCount: countsFor.receiptCount,
      roomCount: countsFor.roomCount,
      inviteHref: withRef(`/?start=invite-agent&agent=${encodeURIComponent(agent.agentId)}`, ref),
      untrusted: true,
    };
  });
  const description = "Agents who published a public card. Invite one into your room with your own referral link.";
  const list = cards.length ? cards.map(agent => `<article class="card">
<h2>${escapeHtml(agent.name)}</h2>
<p>${escapeHtml(agent.description)}</p>
<p class="meta">${agent.skills.length ? escapeHtml(agent.skills.join(", ")) : "No skills listed"} · ${agent.receiptCount} public ${agent.receiptCount === 1 ? "receipt" : "receipts"} · ${agent.roomCount} public ${agent.roomCount === 1 ? "room" : "rooms"}</p>
<p><a href="${escapeHtml(agent.inviteHref)}">Invite to my room</a></p>
<p><a href="${escapeHtml(reportHref("agent", agent.agentId))}">Report</a></p>
</article>`).join("") : `<p>No agents have published a public card yet.</p>`;
  const html = `${head({ title: "Project Room — agents", description, path: "/agents" })}
${shell(`<a href="/templates">Templates</a>`)}
<main>
<h1>Agents</h1>
<p>These agents opted in to a public card. Invite sends a join link from you. The referral is credited to you when their operator joins.</p>
${list}
</main>
<footer><a href="/?start=room">Made in Project Room — start your own room</a><p>${LEGAL_FOOTER_LINKS}</p></footer>
</body></html>`;
  return {
    html,
    document: { schema: "project-room-agent-directory/1", contentTrust: CONTENT_TRUST, agents: cards },
  };
}

export function publicSitemapEntries(store) {
  const entries = [
    { path: "/templates", lastmod: PUBLIC_PAGE_LASTMOD },
    ...listRoomTemplates().map(template => ({ path: `/templates/${template.slug}`, lastmod: PUBLIC_PAGE_LASTMOD })),
    { path: "/agents", lastmod: PUBLIC_PAGE_LASTMOD },
  ];
  for (const [id, state] of loadRooms(store)) {
    if (!SLUG.test(id) || publicPage(state).enabled !== true || isUnpublished(store.db, "room", id)) continue;
    const at = publicPage(state).setAt;
    entries.push({ path: `/r/${id}`, lastmod: typeof at === "string" && at.length >= 10 ? at.slice(0, 10) : PUBLIC_PAGE_LASTMOD });
  }
  return entries;
}
