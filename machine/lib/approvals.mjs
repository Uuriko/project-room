import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { APPROVAL_TTL_MS } from "./protocol.mjs";
import { listEvents, postMessage } from "./room.mjs";
import { configHome } from "./config.mjs";

// listEvents reads pages of this size (room.mjs).
const EVENT_PAGE_SIZE = 100;

function pathFor(home) {
  return join(home, "approvals.json");
}

function load(home) {
  const path = pathFor(home);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function save(home, pending) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(pathFor(home), `${JSON.stringify(pending)}\n`, { mode: 0o600 });
}

export function approvalClass({ tool, slot, args }) {
  if (tool === "credential.use") return "credential.use";
  if (tool === "shell.vm" && slot === "desk") return "shell.desk";
  if (tool === "files.get" && Number(args?.bytes ?? args?.size ?? 0) > 1024 * 1024) return "files.export_large";
  if (args?.restore === true || tool === "desk.restore") return "desk.restore";
  const host = args?.host ?? args?.domain;
  if (typeof host === "string" && host && !(args?.knownHosts ?? []).includes(host)) return "egress.new_domain";
  return null;
}

export async function requestApproval({ home = configHome(), origin, roomId, secret, ownerMemberId, className, detail, now = Date.now() }) {
  // L9: 128-bit codes — a 24-bit code could collide with a historical
  // approval and let an old owner reply satisfy a new request.
  const code = randomBytes(16).toString("hex");
  const pending = load(home);
  pending[code] = { className, ownerMemberId, expiresAt: now + APPROVAL_TTL_MS, createdAt: now, used: false };
  save(home, pending);
  const posted = await postMessage(origin, roomId, secret, `approve ${code} to let ${detail}`);
  // The owner's reply can only come after this request, so polls start at
  // the request's own room position instead of event 1.
  const sequence = posted.value?.sequence;
  if (posted.ok && Number.isSafeInteger(sequence) && sequence > 0) {
    const latest = load(home);
    if (latest[code]) { latest[code].after = sequence; save(home, latest); }
  }
  return { ok: posted.ok, code, expiresAt: pending[code].expiresAt };
}

// Accept only an unused, unexpired reply whose actor is the owner member.
export async function takeApproval({ home = configHome(), origin, roomId, secret, code, now = Date.now() }) {
  const pending = load(home);
  const row = pending[code];
  if (!row || row.used) return { ok: false, reason: "approval_denied" };
  if (now >= row.expiresAt) {
    delete pending[code];
    save(home, pending);
    return { ok: false, reason: "approval_denied" };
  }
  const matches = entry => {
    const event = entry.event ?? entry;
    return event.type === "message.posted"
      && event.actorId === row.ownerMemberId
      && String(event.data?.body ?? "").trim() === `approve ${code}`;
  };
  // M4: page through the room's events instead of reading only the first
  // 100. Each poll resumes at the row's cursor: the request's own position,
  // then wherever the last poll stopped. So a poll reads only new events,
  // and an approval in a room with more than 100 pages of history is still
  // found. Rows saved without a cursor start at 0, as before. The page cap
  // bounds one poll; the next poll continues from where it stopped.
  let after = Number.isSafeInteger(row.after) && row.after > 0 ? row.after : 0;
  let found = false;
  for (let pages = 0; pages < 100 && !found; pages += 1) {
    const page = await listEvents(origin, roomId, secret, after);
    if (!page.ok) return { ok: false, reason: "approval_required" };
    found = page.events.some(matches);
    if (found) break;
    const advanced = Number.isSafeInteger(page.next) && page.next > after;
    if (advanced) after = page.next;
    // A short page is the end of the room for now: stop without another read.
    if (!advanced || page.events.length < EVENT_PAGE_SIZE) break;
  }
  if (!found) {
    if (after !== (row.after ?? 0)) {
      const latest = load(home);
      if (latest[code] && !latest[code].used) { latest[code].after = after; save(home, latest); }
    }
    return { ok: false, reason: "approval_required" };
  }
  row.used = true;
  pending[code] = row;
  save(home, pending);
  return { ok: true };
}
