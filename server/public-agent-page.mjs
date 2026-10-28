// Public agent page. One shareable URL per room agent. Questions live in
// agent_public_asks, never in the room log. The wake is a pointer: kind
// "ask" and message id public-ask:<id>. The question text stays here.
import { createHash, randomBytes } from "node:crypto";
import { DARK_DECLARATIONS, LIGHT_DECLARATIONS } from "../src/design-tokens.js";
import { LEGAL_FOOTER_LINKS } from "./legal-pages.mjs";
import { identityIdForWakeMember } from "./wake-identity-resolution.mjs";

class ServiceError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const agentPublicPageSchema = `
  CREATE TABLE IF NOT EXISTS agent_public_pages (
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    access TEXT NOT NULL CHECK(access IN ('open','knock','closed')),
    blurb TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, member_id)
  );
  CREATE TABLE IF NOT EXISTS agent_public_asks (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    from_name TEXT NOT NULL DEFAULT '',
    question TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('knock','open','answered','rejected')),
    answer TEXT,
    client_hash TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_public_asks_member ON agent_public_asks(room_id, member_id, created_at);
`;

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const ASK_ID = /^ask_[A-Za-z0-9_-]{8,80}$/;
const ACCESS = Object.freeze(["open", "knock", "closed"]);
const RESERVED = new Set([
  "a", "about", "account", "admin", "agent", "agents", "api", "app", "ask", "asks",
  "assets", "auth", "card", "cards", "closed", "demo", "directory", "favicon",
  "health", "healthz", "icon", "inbox", "join", "keys", "knock", "legal", "llms",
  "login", "manifest", "mcp", "me", "null", "offers", "og", "open", "openapi",
  "operator", "opportunities", "owner", "p", "privacy", "public", "public-work",
  "ready", "receipts", "report", "robots", "room", "rooms", "settings", "signin",
  "signup", "sitemap", "static", "support", "terms", "u", "undefined", "version",
  "webhooks", "www",
]);
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const HOUR_MS = 60 * 60 * 1000;
const HOUR_CAP = 30;
const WAITING_CAP = 50;
// One anonymous client must not be able to spend the agent-wide caps.
// Checked before HOUR_CAP and WAITING_CAP. The hash is of the visitor
// address (CF-Connecting-IP on the worker), never the address itself.
const CLIENT_HOUR_CAP = 3;
const CLIENT_WAITING_CAP = 10;
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export { PAGE_CSP as AGENT_PAGE_CSP };

const nowMs = () => Date.now();
const newAskId = () => `ask_${randomBytes(18).toString("base64url")}`;
const askClientHash = address => createHash("sha256").update("public-ask-client\0").update(String(address ?? "")).digest("hex");

const escapeHtml = value => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const nameOf = member => {
  const name = typeof member?.displayName === "string" ? member.displayName.trim() : "";
  return name || "Agent";
};

const oneLine = (value, field, max, code = "invalid_page") => {
  if (typeof value !== "string") fail(422, code, `${field} must be text`);
  const text = value.trim();
  if (text.length > max) fail(422, code, `${field} must be at most ${max} characters`);
  if (CONTROL.test(text) || /[\r\n]/.test(text)) fail(422, code, `${field} must be one line`);
  return text;
};

export function agentPageText(card) {
  const lines = [
    `Ask ${card.name}.`,
    `Access: ${card.access}.`,
    "",
    "POST a question as JSON:",
    `curl -sS --fail-with-body -H 'content-type: application/json' --data '{"question":"Hi. What can you help with?","from":"my-agent"}' ${card.ask}`,
    "",
    "The response has id, status, and poll. GET the poll URL until status is answered.",
    "Accept: text/plain returns the answer, or no reply yet.",
  ];
  if (card.access === "knock") lines.push("Status stays knock until this agent accepts.");
  if (card.access === "closed") lines.push("This agent is not taking questions.");
  return `${lines.join("\n")}\n`;
}

const pageStyle = () => `:root{color-scheme:dark;${DARK_DECLARATIONS}}[data-theme="light"]{color-scheme:light;${LIGHT_DECLARATIONS}}
body{margin:0;background:var(--bg);color:var(--text);font:17px/1.55 var(--font-sans)}
main{max-width:42rem;margin:0 auto;padding:2rem 1.25rem 3rem}
h1{font-size:clamp(1.6rem,5vw,2.2rem);line-height:1.15;letter-spacing:-.03em}
p,pre{overflow-wrap:anywhere}
pre{white-space:pre-wrap;font:0.95rem/1.5 var(--font-mono,ui-monospace,monospace)}
a{color:var(--blue)}
footer{margin-top:2rem;border-top:1px solid var(--line);padding-top:1rem;color:var(--muted)}
@media(pointer:coarse){a{display:inline-flex;align-items:center;min-height:var(--control-min-target-coarse)}}`;

export function agentPageHtml(card) {
  const blurb = card.blurb ? `<p>${escapeHtml(card.blurb)}</p>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(`Ask ${card.name}`)}</title>
<meta name="robots" content="noindex, nofollow">
<style>${pageStyle()}</style>
</head><body><main>
<h1>${escapeHtml(`Ask ${card.name}`)}</h1>
${blurb}<pre>${escapeHtml(agentPageText(card))}</pre>
<footer>${LEGAL_FOOTER_LINKS}</footer>
</main></body></html>`;
}

export function askPollText(ask) {
  if (ask.status === "answered") return `${ask.answer ?? ""}\n`;
  if (ask.status === "rejected") return "Not accepted.\n";
  return "no reply yet\n";
}

const askView = (row, origin, slug) => Object.freeze({
  id: row.id,
  status: row.status,
  question: row.question,
  from: row.from_name,
  answer: row.answer ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  poll: `${origin}/api/public/agents/${slug}/asks/${row.id}`,
});

const publicAskView = (row, origin, slug) => Object.freeze({
  id: row.id,
  status: row.status,
  poll: `${origin}/api/public/agents/${slug}/asks/${row.id}`,
});

export class PublicAgentPages {
  constructor(store) {
    if (!store?.db) fail(500, "agent_page_store_missing", "PublicAgentPages requires a store");
    this.store = store;
    this.db = store.db;
  }

  // Tables created before client_hash exist in production. CREATE TABLE IF
  // NOT EXISTS does not add a column, so the first ask adds it. A second
  // racer that loses the alter sees "duplicate column" and continues.
  _ensureClientHashColumn() {
    const present = this.db.prepare("PRAGMA table_info(agent_public_asks)").all().some(column => column.name === "client_hash");
    if (present) return;
    try {
      this.db.exec("ALTER TABLE agent_public_asks ADD COLUMN client_hash TEXT NOT NULL DEFAULT ''");
    } catch (error) {
      if (!/duplicate column/i.test(String(error?.message ?? error))) throw error;
    }
  }

  _state(roomId) {
    try { return this.store.room(roomId).state; }
    catch (error) {
      if (error?.status === 404) fail(404, "room_not_found", "No such room");
      throw error;
    }
  }

  _agent(state, memberId) {
    const member = state?.members?.[memberId];
    if (!member || member.active === false || member.kind !== "agent") fail(404, "agent_not_found", "No such agent");
    return member;
  }

  _canManage(state, actorId, memberId) {
    if (actorId === state?.room?.ownerId) return;
    const member = state?.members?.[actorId];
    if (actorId === memberId && member && member.active !== false && member.kind === "agent") return;
    fail(403, "owner_required", "Only the room owner or this agent may change the public page");
  }

  _row(roomId, memberId) {
    return this.db.prepare("SELECT * FROM agent_public_pages WHERE room_id=? AND member_id=?").get(roomId, memberId) ?? null;
  }

  _manageView(state, roomId, memberId, origin) {
    const row = this._row(roomId, memberId);
    const waiting = row ? this.db.prepare(
      "SELECT COUNT(*) AS n FROM agent_public_asks WHERE room_id=? AND member_id=? AND status IN ('knock','open')"
    ).get(roomId, memberId).n : 0;
    return Object.freeze({
      memberId,
      name: nameOf(state.members[memberId]),
      slug: row?.slug ?? null,
      access: row?.access ?? null,
      blurb: row?.blurb ?? "",
      enabled: !!(row && row.enabled),
      page: row?.slug ? `${origin}/u/${row.slug}` : null,
      waiting,
    });
  }

  configure(roomId, actorId, memberId, input, origin) {
    return this.store.transaction(() => {
      const state = this._state(roomId);
      this._agent(state, memberId);
      this._canManage(state, actorId, memberId);
      if (!input || typeof input !== "object" || Array.isArray(input)) fail(422, "invalid_page", "Send access, slug, blurb, and enabled");
      const keys = Object.keys(input);
      if (keys.length !== 4 || ["access", "slug", "blurb", "enabled"].some(key => !Object.hasOwn(input, key))) {
        fail(422, "invalid_page", "Send access, slug, blurb, and enabled");
      }
      if (!ACCESS.includes(input.access)) fail(422, "invalid_page", "access must be open, knock, or closed");
      if (typeof input.enabled !== "boolean") fail(422, "invalid_page", "enabled must be true or false");
      const slug = oneLine(input.slug, "slug", 40);
      if (!SLUG.test(slug) || RESERVED.has(slug)) fail(422, "invalid_page", "Choose a short public address of letters, numbers, and hyphens");
      const blurb = oneLine(input.blurb, "blurb", 280);
      const taken = this.db.prepare("SELECT room_id, member_id FROM agent_public_pages WHERE slug=?").get(slug);
      if (taken && (taken.room_id !== roomId || taken.member_id !== memberId)) fail(409, "slug_taken", "That address is already in use");
      const at = nowMs();
      this.db.prepare(`INSERT INTO agent_public_pages
        (room_id, member_id, slug, access, blurb, enabled, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(room_id, member_id) DO UPDATE SET
          slug=excluded.slug, access=excluded.access, blurb=excluded.blurb,
          enabled=excluded.enabled, updated_at=excluded.updated_at`
      ).run(roomId, memberId, slug, input.access, blurb, input.enabled ? 1 : 0, at, at);
      return this._manageView(state, roomId, memberId, origin);
    });
  }

  list(roomId, actorId, origin) {
    const state = this._state(roomId);
    const owner = actorId === state?.room?.ownerId;
    const self = state?.members?.[actorId];
    const selfAgent = !!(self && self.active !== false && self.kind === "agent");
    if (!owner && !selfAgent) fail(403, "owner_required", "Only the room owner or this agent may read the public page");
    const ids = owner
      ? Object.keys(state.members ?? {}).filter(id => {
        const member = state.members[id];
        return member && member.active !== false && member.kind === "agent";
      }).sort()
      : [actorId];
    return Object.freeze({ pages: Object.freeze(ids.map(id => this._manageView(state, roomId, id, origin))) });
  }

  asks(roomId, actorId, memberId, origin) {
    const state = this._state(roomId);
    this._agent(state, memberId);
    this._canManage(state, actorId, memberId);
    const row = this._row(roomId, memberId);
    const slug = row?.slug ?? "";
    const rows = this.db.prepare(
      "SELECT * FROM agent_public_asks WHERE room_id=? AND member_id=? ORDER BY created_at DESC LIMIT 50"
    ).all(roomId, memberId);
    return Object.freeze({
      asks: Object.freeze(rows.map(ask => askView(ask, origin, slug))),
    });
  }

  act(roomId, actorId, memberId, askId, input, origin) {
    return this.store.transaction(() => {
      const state = this._state(roomId);
      this._agent(state, memberId);
      this._canManage(state, actorId, memberId);
      if (!ASK_ID.test(askId)) fail(404, "ask_not_found", "No such question");
      if (!input || typeof input !== "object" || Array.isArray(input)) fail(422, "invalid_ask", "action is required");
      const action = input.action;
      const keys = Object.keys(input);
      if (action === "answer") {
        if (keys.length !== 2 || !Object.hasOwn(input, "answer")) fail(422, "invalid_ask", "answer requires action and answer");
      } else if (action === "accept" || action === "reject") {
        if (keys.length !== 1) fail(422, "invalid_ask", "accept and reject take only action");
      } else fail(422, "invalid_ask", "action must be accept, reject, or answer");
      const row = this.db.prepare(
        "SELECT * FROM agent_public_asks WHERE id=? AND room_id=? AND member_id=?"
      ).get(askId, roomId, memberId);
      if (!row) fail(404, "ask_not_found", "No such question");
      const page = this._row(roomId, memberId);
      const slug = page?.slug ?? "";
      const at = nowMs();
      if (action === "accept") {
        if (row.status === "open") return askView(row, origin, slug);
        if (row.status !== "knock") fail(409, "ask_settled", "That question is already settled");
        this.db.prepare("UPDATE agent_public_asks SET status='open', updated_at=? WHERE id=?").run(at, askId);
      } else if (action === "reject") {
        if (row.status === "rejected") return askView(row, origin, slug);
        if (row.status !== "knock" && row.status !== "open") fail(409, "ask_settled", "That question is already settled");
        this.db.prepare("UPDATE agent_public_asks SET status='rejected', updated_at=? WHERE id=?").run(at, askId);
      } else {
        if (typeof input.answer !== "string") fail(422, "invalid_ask", "answer must be text");
        const answer = input.answer.trim();
        if (answer.length < 1 || answer.length > 4000) fail(422, "invalid_ask", "answer must be 1-4000 characters");
        if (CONTROL.test(answer)) fail(422, "invalid_ask", "answer has unsupported characters");
        if (row.status !== "knock" && row.status !== "open") fail(409, "ask_settled", "That question is already settled");
        this.db.prepare("UPDATE agent_public_asks SET status='answered', answer=?, updated_at=? WHERE id=?").run(answer, at, askId);
      }
      const next = this.db.prepare("SELECT * FROM agent_public_asks WHERE id=?").get(askId);
      return askView(next, origin, slug);
    });
  }

  _publicRow(slug) {
    if (typeof slug !== "string" || !SLUG.test(slug) || RESERVED.has(slug)) fail(404, "agent_not_found", "No such agent.");
    const row = this.db.prepare("SELECT * FROM agent_public_pages WHERE slug=? AND enabled=1").get(slug);
    if (!row) fail(404, "agent_not_found", "No such agent.");
    let state;
    try { state = this.store.room(row.room_id).state; }
    catch { fail(404, "agent_not_found", "No such agent."); }
    if (typeof state?.room?.archivedAt === "string" && state.room.archivedAt) fail(404, "agent_not_found", "No such agent.");
    const member = state?.members?.[row.member_id];
    if (!member || member.active === false || member.kind !== "agent") fail(404, "agent_not_found", "No such agent.");
    return { row, member };
  }

  card(slug, origin) {
    const { row, member } = this._publicRow(slug);
    return Object.freeze({
      slug: row.slug,
      name: nameOf(member),
      blurb: row.blurb,
      access: row.access,
      page: `${origin}/u/${row.slug}`,
      ask: `${origin}/api/public/agents/${row.slug}/asks`,
      poll: `${origin}/api/public/agents/${row.slug}/asks/{id}`,
    });
  }

  postAsk(slug, input, origin, clientAddress = "") {
    this._ensureClientHashColumn();
    const clientHash = askClientHash(clientAddress);
    const created = this.store.transaction(() => {
      const { row } = this._publicRow(slug);
      if (row.access === "closed") fail(403, "agent_closed", "This agent is not taking questions.");
      if (!input || typeof input !== "object" || Array.isArray(input)) fail(422, "invalid_ask", "question is required");
      const keys = Object.keys(input);
      if (!Object.hasOwn(input, "question") || keys.some(key => key !== "question" && key !== "from")) {
        fail(422, "invalid_ask", "question is required; from is optional");
      }
      if (typeof input.question !== "string") fail(422, "invalid_ask", "question must be text");
      const question = input.question.trim();
      if (question.length < 1 || question.length > 2000) fail(422, "invalid_ask", "question must be 1-2000 characters");
      if (CONTROL.test(question)) fail(422, "invalid_ask", "question has unsupported characters");
      let from = "";
      if (Object.hasOwn(input, "from")) from = oneLine(input.from, "from", 80, "invalid_ask");
      const at = nowMs();
      const clientRecent = this.db.prepare(
        "SELECT COUNT(*) AS n FROM agent_public_asks WHERE room_id=? AND member_id=? AND client_hash=? AND created_at>?"
      ).get(row.room_id, row.member_id, clientHash, at - HOUR_MS).n;
      if (clientRecent >= CLIENT_HOUR_CAP) fail(429, "rate_limited", "Too many questions from this client for this agent this hour.");
      const clientWaiting = this.db.prepare(
        "SELECT COUNT(*) AS n FROM agent_public_asks WHERE client_hash=? AND status IN ('knock','open')"
      ).get(clientHash).n;
      if (clientWaiting >= CLIENT_WAITING_CAP) fail(429, "rate_limited", "Too many waiting questions from this client.");
      const recent = this.db.prepare(
        "SELECT COUNT(*) AS n FROM agent_public_asks WHERE room_id=? AND member_id=? AND created_at>?"
      ).get(row.room_id, row.member_id, at - HOUR_MS).n;
      if (recent >= HOUR_CAP) fail(429, "rate_limited", "Too many questions for this agent this hour.");
      const waiting = this.db.prepare(
        "SELECT COUNT(*) AS n FROM agent_public_asks WHERE room_id=? AND member_id=? AND status IN ('knock','open')"
      ).get(row.room_id, row.member_id).n;
      if (waiting >= WAITING_CAP) fail(429, "rate_limited", "This agent has too many waiting questions.");
      const id = newAskId();
      const status = row.access === "knock" ? "knock" : "open";
      this.db.prepare(`INSERT INTO agent_public_asks
        (id, room_id, member_id, from_name, question, status, answer, client_hash, created_at, updated_at)
        VALUES (?,?,?,?,?,?,NULL,?,?,?)`
      ).run(id, row.room_id, row.member_id, from, question, status, clientHash, at, at);
      const ask = this.db.prepare("SELECT * FROM agent_public_asks WHERE id=?").get(id);
      let signal = null;
      let identityId = null;
      try {
        identityId = identityIdForWakeMember(this.db, row.room_id, row.member_id);
        if (identityId) {
          const woke = this.store.agentHeartbeats.wakeIfOffline({
            agentId: identityId, kind: "ask", roomId: row.room_id, messageId: `public-ask:${id}`,
          });
          signal = woke.signal;
        }
      } catch { signal = null; identityId = null; }
      return { view: publicAskView(ask, origin, row.slug), signal, identityId };
    });
    if (created.signal && created.identityId) {
      try { this.store.agentPlugin?.deliverWakePing({ identityId: created.identityId, signal: created.signal }); }
      catch { /* the ask is already stored; the wake queue still holds the pointer */ }
    }
    return created.view;
  }

  poll(slug, askId, origin) {
    const { row } = this._publicRow(slug);
    if (!ASK_ID.test(String(askId ?? ""))) fail(404, "ask_not_found", "No such question.");
    const ask = this.db.prepare(
      "SELECT * FROM agent_public_asks WHERE id=? AND room_id=? AND member_id=?"
    ).get(askId, row.room_id, row.member_id);
    if (!ask) fail(404, "ask_not_found", "No such question.");
    return Object.freeze({
      id: ask.id,
      status: ask.status,
      question: ask.question,
      from: ask.from_name,
      answer: ask.answer ?? null,
      poll: `${origin}/api/public/agents/${row.slug}/asks/${ask.id}`,
    });
  }
}
