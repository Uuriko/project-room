// WORKER-47 round 3: bearer regex boundary lengths for GET /api/agent-rooms.
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
const f = createAcceptanceFixture();
const server = createRoomServer({ store: f.store });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const logLines = [];
const log = (m) => { logLines.push(m); console.log(m); };
const findings = [];
async function t(name, auth, expect) {
  const res = await fetch(origin + "/api/agent-rooms", { headers: { Authorization: auth } });
  const body = (await res.text()).slice(0, 160);
  const ok = res.status === expect;
  log(`${ok ? "ok  " : "FAIL"} ${name}: ${res.status} (expect ${expect}) ${ok ? "" : body}`);
  if (!ok) findings.push(`${name}: got ${res.status}, expected ${expect}: ${body}`);
}
// regex: ^[Bb][Ee][Aa][Rr][Ee][Rr] ([A-Za-z0-9_-]{43}|ga1\.[A-Za-z0-9_-]{43}|pri_[A-Za-z0-9_-]{43,128}|rak_[A-Za-z0-9_-]{16,128})$
await t("43-char token (min)", "Bearer " + "A".repeat(43), 401);          // shape ok, unknown identity
await t("42-char token (too short)", "Bearer " + "A".repeat(42), 401);     // invalid header
await t("pri_+42 (too short)", "Bearer pri_" + "A".repeat(42), 401);       // invalid header
await t("pri_+43 (min)", "Bearer pri_" + "A".repeat(43), 401);             // unknown identity
await t("pri_+128 (max)", "Bearer pri_" + "A".repeat(128), 401);           // unknown identity
await t("pri_+129 (too long)", "Bearer pri_" + "A".repeat(129), 401);      // invalid header
await t("ga1.+43", "Bearer ga1." + "A".repeat(43), 401);
await t("ga1.+42 (short)", "Bearer ga1." + "A".repeat(42), 401);
await t("rak_+16 (min)", "Bearer rak_" + "A".repeat(16), 401);
await t("rak_+15 (short)", "Bearer rak_" + "A".repeat(15), 401);
await t("rak_+128 (max)", "Bearer rak_" + "A".repeat(128), 401);
await t("token with '.' inside", "Bearer " + "A".repeat(42) + ".", 401);
await t("double space", "Bearer  " + "A".repeat(43), 401);
await t("BEARER uppercase scheme", "BEARER " + "A".repeat(43), 401);
log(`\nDONE: ${findings.length} finding(s)`);
for (const x of findings) log(" * " + x);
import { writeFileSync } from "node:fs";
writeFileSync(new URL("./fuzz3.log", import.meta.url), logLines.join("\n") + "\n");
server.closeStreams(); server.closeAllConnections();
await new Promise((r) => server.close(r));
f.store.close();
