// D09 isolation check: whitespace displayName on a FRESH boot (no "Invited agent" member yet).
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { scryptSync } from "node:crypto";
const codeHash = (code) => scryptSync(code, "project-room-agent-invite-v2", 32, { N: 16384, r: 8, p: 1 }).toString("hex");
const fixture = await createAcceptanceFixture();
const store = fixture.store;
const server = createRoomServer({ store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const roomId = store.db.prepare("SELECT id FROM rooms LIMIT 1").get().id;
const ownerId = store.roomAuthority(roomId).ownerId;
const now = store.now();
const code = "RM-" + "5".repeat(16);
store.db.prepare(`INSERT INTO agent_invite_codes(code_hash,room_id,created_by,permissions_json,display_name,created_at,expires_at,redeemed_at,redeemed_identity_id,revoked_at)
  VALUES(?,?,?,?,?,?,?,?,?,?)`).run(codeHash(code), roomId, ownerId, JSON.stringify(["steer"]), null, now, now + 3600000, null, null, null);
const r = await fetch(base + "/api/agent-invites/redeem", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code, displayName: "   " }),
});
const t = await r.text();
console.log("status:", r.status);
console.log("displayName in body:", /"displayName":"[^"]*"/.exec(t)?.[0]);
server.closeAllConnections(); await new Promise(res => server.close(res)); store.close();
