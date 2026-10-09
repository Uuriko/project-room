// Worker 43 round 3: determinism + boundary checks.
import { mkdirSync, writeFileSync } from "node:fs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

mkdirSync(new URL("data", import.meta.url), { recursive: true });
const store = new RoomStore(new URL("data/room.sqlite", import.meta.url).pathname, {});
const server = createRoomServer({ store });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
const P = "/api/referral-invites/preview";
const A = "/api/account/ensure-default-room";
const out = [];
const post = (path, body, headers = {}) => fetch(BASE + path, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body)
}).then(async r => ({ status: r.status, body: (await r.text()).slice(0, 120) }));

// determinism: 5 sequential 100KB-token posts -> all 413?
for (let i = 0; i < 5; i++) {
  const r = await post(P, { token: "a".repeat(100000) });
  out.push(`100k-token run${i}: ${r.status}`);
}
// boundary: body just under the 16384 limit -> processed normally (404, not 413)
const small = "t".repeat(15000);
const r1 = await post(P, { token: small });
out.push(`15k-token (body ${JSON.stringify({ token: small }).length}B): ${r1.status} ${r1.body.slice(0, 60)}`);
// duplicate session cookies -> ambiguous_session_cookie 401
const dup = await fetch(BASE + A, { method: "POST", headers: { "Content-Type": "application/json", Cookie: "account_session=a; account_session=b", "X-Session-Binding": "ab".repeat(32) } });
out.push(`dup-cookie: ${dup.status} ${(await dup.text()).slice(0, 90)}`);
// cookie name scoping: similarly-named cookie must not match
const scoped = await post(A, {}, { Cookie: "xaccount_session=zzz", "X-Session-Binding": "ab".repeat(32) });
out.push(`scoped-cookie-name: ${scoped.status} ${scoped.body.slice(0, 70)}`);

console.log(out.join("\n"));
writeFileSync(new URL("fuzz-results-round3.txt", import.meta.url), out.join("\n") + "\n");
server.closeStreams(); server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
store.close();
