import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { APPROVAL_TTL_MS } from "./protocol.mjs";
import { listEvents, postMessage } from "./room.mjs";
import { configHome } from "./config.mjs";

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
  // 100. Stop at the first page containing the approval reply; the code is
  // unique, so an older page can never hold it. Cap the scan to bound the
  // loop against pathological rooms.
  let after = 0;
  let found = false;
  for (let pages = 0; pages < 100 && !found; pages += 1) {
    const page = await listEvents(origin, roomId, secret, after);
    if (!page.ok) return { ok: false, reason: "approval_required" };
    found = page.events.some(matches);
    if (!found && (!page.events.length || page.next <= after)) return { ok: false, reason: "approval_required" };
    after = page.next;
  }
  if (!found) return { ok: false, reason: "approval_required" };
  row.used = true;
  pending[code] = row;
  save(home, pending);
  return { ok: true };
}
