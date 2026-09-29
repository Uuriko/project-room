// GitHub door: a Room route for agents whose sandbox reaches github.com but not
// the Room origins (cloud coding agents, Cowork, CI bots). One GitHub issue is
// the door. Comments from trusted GitHub users go into one room as attributed,
// unverified messages; new room messages come back as one digest comment.
//
// The bridge holds a single Room identity (repo secret ROOM_DOOR_SECRET). It
// never reads or posts anything a comment asks for beyond "say this in the
// room", never runs code from a comment, and never echoes a secret.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { validId, MAX_MESSAGE_BODY_CHARS } from "../src/events.js";

export const OUT_MARKER = "<!-- room-door:out";
export const TRUSTED_ASSOCIATIONS = Object.freeze(["OWNER", "MEMBER", "COLLABORATOR"]);
const DIGEST_LIMIT = 60000; // GitHub comment ceiling is 65536 characters.

// Deterministic command id per GitHub comment so a rerun (or a retried
// workflow) posts once. Shaped like a UUID to match other command ids.
export function commandIdFor(repo, commentId) {
  const h = createHash("sha256").update(`github-door:${repo}:${commentId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function parseAllowlist(value) {
  return new Set(String(value ?? "").split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean));
}

// Returns null when the comment must not enter the room, else { text, replyToId }.
export function parseDoorComment({ body, login, association, isBot = false }, { allow = new Set() } = {}) {
  if (typeof body !== "string" || typeof login !== "string") return null;
  if (body.includes(OUT_MARKER)) return null; // our own digest
  if (isBot && !allow.has(login.toLowerCase())) return null;
  if (!TRUSTED_ASSOCIATIONS.includes(association) && !allow.has(login.toLowerCase())) return null;
  let text = body.replace(/\r\n/g, "\n").trim();
  if (/^\/room\b/i.test(text)) text = text.replace(/^\/room\b[ \t]*/i, "");
  else if (/^\/(?:skip|nope|no-room)\b/i.test(text)) return null;
  let replyToId;
  const reply = /^reply-to:[ \t]*(\S+)[ \t]*\n/i.exec(text);
  if (reply && validId(reply[1])) { replyToId = reply[1]; text = text.slice(reply[0].length); }
  text = text.trim();
  if (!text) return null;
  return { text, ...(replyToId ? { replyToId } : {}) };
}

export function inboundCommand({ repo, comment, parsed }) {
  const header = `**@${comment.login}** via GitHub (unverified): `;
  const footer = `\n\n[source](${comment.url})`;
  const room = MAX_MESSAGE_BODY_CHARS - header.length - footer.length - 1;
  const text = parsed.text.length > room ? parsed.text.slice(0, room - 1) + "…" : parsed.text;
  const id = commandIdFor(repo, comment.id);
  return { id, type: "message.posted", data: {
    messageId: id, body: header + text + footer, ...(parsed.replyToId ? { replyToId: parsed.replyToId } : {})
  } };
}

// Highest room sequence already mirrored, read from our own digest comments.
export function readCursor(comments) {
  let best = 0;
  for (const c of comments ?? []) {
    const m = /<!-- room-door:out seq=(\d+) -->/.exec(c?.body ?? "");
    if (m) best = Math.max(best, Number(m[1]));
  }
  return best;
}

const quote = s => s.split("\n").map(line => `> ${line}`).join("\n");

export function outboundDigest(messages, { roomId, selfMemberId, names = {}, cursor = 0 } = {}) {
  const fresh = (messages ?? []).filter(m => m.sequence > cursor && !m.private && m.from !== selfMemberId);
  const last = (messages ?? []).reduce((n, m) => Math.max(n, m.sequence ?? 0), cursor);
  if (!fresh.length) return { body: null, cursor: last };
  const parts = [`${OUT_MARKER} seq=${last} -->`, `New in \`${roomId}\` (reply here; start a line with \`reply-to: <id>\` to thread):`];
  let size = parts.join("\n").length;
  for (const m of fresh) {
    const who = names[m.from] ?? m.from;
    const entry = `\n**${who}** · \`${m.messageId}\`\n${quote(m.body.length > 4000 ? m.body.slice(0, 3999) + "…" : m.body)}`;
    if (size + entry.length > DIGEST_LIMIT) { parts.push("\n…more in the room."); break; }
    parts.push(entry); size += entry.length;
  }
  return { body: parts.join("\n"), cursor: last };
}

async function gh(path, { token, method = "GET", body, fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
      "User-Agent": "project-room-github-door", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path} failed: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function allComments(repo, issue, token, fetchImpl) {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await gh(`/repos/${repo}/issues/${issue}/comments?per_page=100&page=${page}`, { token, fetchImpl });
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

export async function runInbound({ event, repo, client, allow, doorIssue }) {
  const issue = event?.issue, c = event?.comment;
  if (!issue || !c || event.action !== "created") return { skipped: "not a new comment" };
  if (String(issue.number) !== String(doorIssue)) return { skipped: "not the door issue" };
  const comment = { id: c.id, login: c.user?.login, url: c.html_url, body: c.body,
    association: c.author_association, isBot: c.user?.type === "Bot" };
  const parsed = parseDoorComment(comment, { allow });
  if (!parsed) return { skipped: "untrusted or empty" };
  const receipt = await client.command(inboundCommand({ repo, comment, parsed }));
  return { posted: true, sequence: receipt?.sequence ?? null, duplicate: Boolean(receipt?.duplicate) };
}

export async function runOutbound({ repo, doorIssue, token, client, roomId, selfMemberId, fetchImpl = globalThis.fetch }) {
  const cursor = readCursor((await allComments(repo, doorIssue, token, fetchImpl)).filter(c => c.body?.includes(OUT_MARKER)));
  const messages = []; let after = cursor;
  for (let i = 0; i < 20; i++) {
    const page = await client.roomMessages({ after, limit: 100 });
    messages.push(...page.messages);
    if (!page.hasMore || page.next === after) { after = page.next; break; }
    after = page.next;
  }
  const digest = outboundDigest(messages, { roomId, selfMemberId, cursor });
  if (!digest.body) return { posted: false, cursor: digest.cursor };
  await gh(`/repos/${repo}/issues/${doorIssue}/comments`, { token, method: "POST", body: { body: digest.body }, fetchImpl });
  return { posted: true, cursor: digest.cursor, count: messages.length };
}

export async function main(env = process.env, argv = process.argv) {
  const mode = argv[2];
  const origin = env.ROOM_ORIGIN || "https://room.trydemigod.com";
  const need = ["ROOM_DOOR_SECRET", "ROOM_DOOR_ROOM", "ROOM_DOOR_ISSUE", "GITHUB_REPOSITORY"];
  const missing = need.filter(k => !env[k]?.trim());
  if (missing.length) { console.log(JSON.stringify({ ok: false, skipped: `door not configured: ${missing.join(", ")}` })); return; }
  const client = new RoomAgentClient({ origin, roomId: env.ROOM_DOOR_ROOM, token: env.ROOM_DOOR_SECRET.trim(),
    ...(env.ROOM_DOOR_MEMBER ? { memberId: env.ROOM_DOOR_MEMBER } : {}) });
  let result;
  if (mode === "in") {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    result = await runInbound({ event, repo: env.GITHUB_REPOSITORY, client, allow: parseAllowlist(env.ROOM_DOOR_ALLOW), doorIssue: env.ROOM_DOOR_ISSUE });
  } else if (mode === "out") {
    if (!env.ROOM_DOOR_MEMBER?.trim()) throw new Error("ROOM_DOOR_MEMBER is required so the door never mirrors its own posts");
    result = await runOutbound({ repo: env.GITHUB_REPOSITORY, doorIssue: env.ROOM_DOOR_ISSUE, token: env.GITHUB_TOKEN,
      client, roomId: env.ROOM_DOOR_ROOM, selfMemberId: env.ROOM_DOOR_MEMBER });
  } else throw new Error("usage: github-door.mjs in|out");
  console.log(JSON.stringify({ ok: true, mode, ...result }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
