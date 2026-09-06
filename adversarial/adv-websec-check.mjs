// Pass 30: CSRF / Origin / Host matrix. Real HTTP server, loopback.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

let pass = 0, failCount = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { failCount++; console.log(`FAIL ${name} ${detail}`); }
};
const directory = mkdtempSync(join(tmpdir(), "adv-websec-"));
const store = new RoomStore(join(directory, "room.sqlite"));
store.initialize(initialRoom());
const ownerKey = store.issueAccessKey("commons", "owner");
const session = store.createSession(ownerKey);
const cookie = `room_session=${session.token}`;
const csrf = store.authenticate(session.token).csrf;
const server = createRoomServer({ store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const req = (path, { method = "GET", headers = {}, body } = {}) => fetch(`${origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const write = (headers) => req("/api/rooms/commons/cursor", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: { sequence: 0 } });

// Origin matrix
check("GET without Origin allowed", (await req("/api/rooms/commons", { headers: { Authorization: `Bearer ${ownerKey}` } })).status === 200);
{
  const r = await req("/api/rooms/commons", { headers: { Authorization: `Bearer ${ownerKey}`, Origin: "http://evil.example" } });
  const b = await r.json();
  check("wrong-Origin GET body is origin_denied", r.status === 403 && b.error?.code === "origin_denied", `status=${r.status} code=${b.error?.code}`);
  const r2 = await req("/api/rooms/commons", { headers: { Authorization: `Bearer ${ownerKey}`, Origin: origin } });
  check("GET with correct Origin allowed", r2.status === 200, `status=${r2.status}`);
}
// Login origin requirement
{
  const noOrigin = await req("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: { accessKey: ownerKey } });
  check("login without Origin rejected 403 (origin required)", noOrigin.status === 403 && (await noOrigin.json()).error?.code === "origin_denied", `status=${noOrigin.status}`);
  const wrongOrigin = await req("/api/session", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://attacker.test" }, body: { accessKey: ownerKey } });
  check("login with wrong Origin rejected 403", wrongOrigin.status === 403, `status=${wrongOrigin.status}`);
  const good = await req("/api/session", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: { accessKey: ownerKey } });
  const setCookie = good.headers.get("set-cookie") || "";
  check("login with correct Origin succeeds 201", good.status === 201, `status=${good.status}`);
  check("cookie is HttpOnly + SameSite=Strict + Path=/, no Secure on http origin",
    /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie) && /Path=\//.test(setCookie) && !/Secure/i.test(setCookie), setCookie);
}
// CSRF matrix (cookie-authenticated writes)
{
  const noCsrf = await write({ Cookie: cookie, Origin: origin });
  check("cookie write without X-CSRF-Token rejected 403 csrf_denied", noCsrf.status === 403 && (await noCsrf.json()).error?.code === "csrf_denied", `status=${noCsrf.status}`);
  const malformed = await write({ Cookie: cookie, Origin: origin, "X-CSRF-Token": "abc" });
  check("malformed CSRF token rejected 403", malformed.status === 403, `status=${malformed.status}`);
  const wrong = await write({ Cookie: cookie, Origin: origin, "X-CSRF-Token": "0".repeat(64) });
  check("well-formed wrong CSRF token rejected 403", wrong.status === 403, `status=${wrong.status}`);
  const good = await write({ Cookie: cookie, Origin: origin, "X-CSRF-Token": csrf });
  check("correct CSRF token accepted", good.status === 200, `status=${good.status}`);
  const noOriginWrite = await write({ Cookie: cookie, "X-CSRF-Token": csrf });
  check("cookie write without Origin rejected 403 (origin required on writes)", noOriginWrite.status === 403 && (await noOriginWrite.json()).error?.code === "origin_denied", `status=${noOriginWrite.status}`);
}
// Bearer path
{
  const noOrigin = await write({ Authorization: `Bearer ${ownerKey}` });
  check("bearer write without Origin allowed (API client shape)", noOrigin.status === 200, `status=${noOrigin.status}`);
  const wrongOrigin = await write({ Authorization: `Bearer ${ownerKey}`, Origin: "http://evil.example" });
  check("bearer write with WRONG Origin present rejected 403", wrongOrigin.status === 403, `status=${wrongOrigin.status}`);
  const malformedBearer = await req("/api/rooms/commons", { headers: { Authorization: "Bearer tooshort" } });
  check("malformed bearer rejected 401", malformedBearer.status === 401, `status=${malformedBearer.status}`);
  const accessKeyInCookie = await req("/api/rooms/commons", { headers: { Cookie: `room_session=${ownerKey}`, Origin: origin } });
  check("access key smuggled via cookie rejected 401 (browser session required)", accessKeyInCookie.status === 401, `status=${accessKeyInCookie.status}`);
}
// Host header check (raw http.request - fetch cannot set Host)
{
  const result = await new Promise(resolve => {
    const r = http.request({ host: "127.0.0.1", port: server.address().port, path: "/api/health", method: "GET", headers: { Host: "evil.example", Authorization: `Bearer ${ownerKey}` } }, res => {
      let data = ""; res.on("data", c => data += c); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    r.end();
  });
  check("mismatched Host rejected 403 host_denied", result.status === 403 && result.body.error?.code === "host_denied", `status=${result.status}`);
}
// Security headers + sign-out
{
  const r = await req("/api/rooms/commons", { headers: { Authorization: `Bearer ${ownerKey}` } });
  check("CSP + nosniff + no-referrer + no-store headers present",
    (r.headers.get("content-security-policy") || "").includes("default-src 'none'") && r.headers.get("x-content-type-options") === "nosniff" && r.headers.get("referrer-policy") === "no-referrer" && r.headers.get("cache-control") === "no-store");
  const s2 = store.createSession(ownerKey);
  const out = await req("/api/session", { method: "DELETE", headers: { Cookie: `room_session=${s2.token}`, Origin: origin, "X-CSRF-Token": store.authenticate(s2.token).csrf } });
  check("DELETE /api/session signs out 200", out.status === 200, `status=${out.status}`);
  check("sign-out clears cookie (Max-Age=0)", /Max-Age=0/.test(out.headers.get("set-cookie") || ""));
  const after = await req("/api/rooms/commons", { headers: { Cookie: `room_session=${s2.token}`, Origin: origin } });
  check("signed-out token no longer authenticates (401)", after.status === 401, `status=${after.status}`);
}
server.closeStreams(); server.closeAllConnections(); server.close();
store.close(); rmSync(directory, { recursive: true, force: true });
console.log(`\n${pass} pass / ${failCount} fail`);
process.exit(failCount ? 1 : 0);
