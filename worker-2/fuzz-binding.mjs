// WAVE-2000 guild-02 worker-2 — third fuzz batch.
// /api/updates account-cookie path with binding variants + raw-socket
// malformed-HTTP survivability. Never touches production.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import net from "node:net";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

const TIMEOUT_MS = 6000;
const dir = mkdtempSync(join(tmpdir(), "w2fuzz3-"));
const store = new RoomStore(join(dir, "room.sqlite"));
store.initialize(initialRoom("commons"));
const server = createRoomServer({ store });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const port = server.address().port;

async function probe(name, method, path, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let status, bodyHead, err = null;
  try {
    const res = await fetch(`${origin}${path}`, { method, headers, signal: ctl.signal });
    status = res.status;
    bodyHead = (await res.text()).slice(0, 100);
  } catch (e) { err = e?.name === "AbortError" ? "TIMEOUT" : `FETCH-ERROR: ${e?.message}`; }
  finally { clearTimeout(timer); }
  return { name, status, bodyHead, err };
}

// --- get a logged-in account cookie ---
const slot = store.createAccountSessionSlot();
let cookie = null;
{
  const res = await fetch(`${origin}/api/auth/password/signup`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ email: "fuzz3@example.invalid", password: "fixture-password-3-long-enough",
      sessionToken: slot.token, sessionRevision: slot.session.sessionRevision }),
  });
  const m = /account_session=([^;]+)/.exec(res.headers.get("set-cookie") || "");
  if (!m) { console.log("!! signup failed"); process.exit(2); }
  cookie = `account_session=${m[1]}`;
}

const hex64 = createHash("sha256").update("fuzz-binding").digest("hex");
const results = [];
const UP = "/api/updates";
const C = { Cookie: cookie };

results.push(await probe("bind:valid-hex", "GET", `${UP}?binding=${hex64}`, C));
results.push(await probe("bind:upper-hex", "GET", `${UP}?binding=${hex64.toUpperCase()}`, C));
results.push(await probe("bind:short", "GET", `${UP}?binding=${hex64.slice(0, 63)}`, C));
results.push(await probe("bind:long", "GET", `${UP}?binding=${hex64}00`, C));
results.push(await probe("bind:empty", "GET", `${UP}?binding=`, C));
results.push(await probe("bind:dup", "GET", `${UP}?binding=${hex64}&binding=${hex64}`, C));
results.push(await probe("bind:nonhex", "GET", `${UP}?binding=${"g".repeat(64)}`, C));
results.push(await probe("bind:header-bad", "GET", UP, { ...C, "X-Session-Binding": "zzz" }));
results.push(await probe("bind:header-hex", "GET", UP, { ...C, "X-Session-Binding": hex64 }));
results.push(await probe("bind:query+limit-bad", "GET", `${UP}?binding=${hex64}&limit=abc`, C));
results.push(await probe("bind:query+huge", "GET", `${UP}?binding=${hex64}&limit=99999999999999`, C));
results.push(await probe("bind:sql", "GET", `${UP}?binding=${hex64}' OR '1'='1`, C));

// --- raw socket: malformed HTTP must not kill the process ---
function rawTest(name, payload) {
  return new Promise(resolve => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(payload));
    let data = "";
    const timer = setTimeout(() => { sock.destroy(); resolve({ name, err: "TIMEOUT" }); }, TIMEOUT_MS);
    sock.on("data", d => { data += d.toString("latin1"); });
    sock.on("close", () => { clearTimeout(timer); resolve({ name, reply: data.slice(0, 60).replace(/\r\n/g, " | ") }); });
    sock.on("error", e => { clearTimeout(timer); resolve({ name, err: e.message }); });
    setTimeout(() => { if (!sock.destroyed) sock.end(); }, 800);
  });
}
const rawResults = [];
rawResults.push(await rawTest("raw:garbage", "HELLO WORLD\r\n\r\n"));
rawResults.push(await rawTest("raw:no-crlf", "GET /api/updates HTTP/1.1"));
rawResults.push(await rawTest("raw:oversized-header", `GET /api/updates HTTP/1.1\r\nHost: x\r\nX-Big: ${"y".repeat(20000)}\r\n\r\n`));
rawResults.push(await rawTest("raw:null-bytes", "GET /api/updates\x00 HTTP/1.1\r\nHost: x\r\n\r\n"));
// server must still answer after the abuse
rawResults.push(await probe("post-raw:health", "GET", "/api/health"));

for (const r of results) console.log(`${r.err ? "!!" : ""}${r.status ?? r.err}\t${r.name}\t${JSON.stringify(r.bodyHead)}`);
for (const r of rawResults) console.log(`${r.err ? "!!" : "raw"}\t${r.name}\t${r.reply ?? r.err}`);

server.closeStreams();
server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
store.close();
rmSync(dir, { recursive: true, force: true });
