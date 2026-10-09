// WAVE-2000 worker-36 follow-up: verify the guest-agent gate and re-run
// the two cases whose first-pass expectations were wrong.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const directory = mkdtempSync(join(tmpdir(), "w36-fuzz2-"));
let clock = Date.parse("2026-10-09T09:00:00Z");
const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
store.initialize(initialRoom());
const keys = { owner: store.issueAccessKey("commons", "owner") };
const send = (actor, type, data) => store.command(keys[actor], "commons", { id: randomUUID(), type, data });
// guest-agent member via direct add (gate keys on the id prefix only)
send("owner", T.MEMBER_ADDED, { memberId: "guest-agent-fuzz", displayName: "Fuzz Guest Agent", kind: "agent", permissions: [], accountableHumanId: "owner" });
keys.guestAgent = store.issueAccessKey("commons", "guest-agent-fuzz");
send("owner", T.MEMBER_ADDED, { memberId: "reviewer", displayName: "Test reviewer", kind: "agent", permissions: ["verify"], accountableHumanId: "owner" });
keys.reviewer = store.issueAccessKey("commons", "reviewer");
for (const memberId of ["guest-agent-fuzz", "reviewer"]) setTier(store.db, "commons", memberId, "t2_standard", { updatedBy: "owner", nowMs: clock });
send("owner", T.MESSAGE_POSTED, { messageId: "m2", body: "owner message" });

const server = createRoomServer({ store });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function call(label, method, path, { key, body, rawBody, headers = {} } = {}) {
  const h = { Origin: origin, ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers };
  let raw;
  if (rawBody !== undefined) { raw = rawBody; h["Content-Type"] = h["Content-Type"] ?? "application/json"; }
  else if (body !== undefined) { raw = JSON.stringify(body); h["Content-Type"] = "application/json"; }
  try {
    const res = await fetch(`${origin}${path}`, { method, headers: h, body: raw, signal: AbortSignal.timeout(5000) });
    const text = await res.text();
    let code = null; try { code = JSON.parse(text)?.code ?? null; } catch {}
    console.log(`${res.status} [${code ?? "-"}] ${label}`);
  } catch (e) { console.log(`FETCH-ERROR ${label}: ${e.message}`); }
}

const R = "/api/rooms/commons/reports";
// 1. guest-agent member files a report -> expect 403 guest_scope_denied
await call("guest-agent report (expect 403 guest_scope_denied)", "POST", R, { key: keys.guestAgent, body: { messageId: "m2", reason: "guest agent tries" } });
// 2. charset content-type with a message the reporter did not write -> expect 201
await call("charset ct, reviewer reports m2 (expect 201)", "POST", R, { key: keys.reviewer, rawBody: JSON.stringify({ messageId: "m2", reason: "charset works" }), headers: { "Content-Type": "application/json; charset=utf-8" } });
// 3. ?auth=banana with NO credential at all -> expect 422 invalid_auth_mode
await call("no cred + ?auth=banana (expect 422)", "GET", "/api/rooms/commons/reminders?auth=banana");
await call("no cred + ?auth=banana post (expect 422)", "POST", R, { rawBody: JSON.stringify({ messageId: "m2", reason: "x" }), headers: {} });

server.closeStreams(); server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
store.close(); rmSync(directory, { recursive: true, force: true });
