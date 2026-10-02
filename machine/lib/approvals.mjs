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
  const code = randomBytes(3).toString("hex");
  const pending = load(home);
  pending[code] = { className, ownerMemberId, expiresAt: now + APPROVAL_TTL_MS, used: false };
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
  const page = await listEvents(origin, roomId, secret, 0);
  if (!page.ok) return { ok: false, reason: "approval_required" };
  const reply = page.events.find(entry => {
    const event = entry.event ?? entry;
    return event.type === "message.posted"
      && event.actorId === row.ownerMemberId
      && String(event.data?.body ?? "").trim() === `approve ${code}`;
  });
  if (!reply) return { ok: false, reason: "approval_required" };
  row.used = true;
  pending[code] = row;
  save(home, pending);
  return { ok: true };
}
