// WAVE-2000 guild-02 worker-2 — second fuzz batch: authenticated paths.
// Creates a real account via /api/auth/password/signup, then fuzzes
//   2b. /api/auth/github/link/start with a VALID account session
//       (exercises the 503 github_not_configured branch + session handling)
//   3b. /api/updates via account_session cookie (listAccountUpdates branch)
// Never touches production. 6s per-request timeout; crashes/hangs reported.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

const TIMEOUT_MS = 6000;
const dir = mkdtempSync(join(tmpdir(), "w2fuzz2-"));
const store = new RoomStore(join(dir, "room.sqlite"));
store.initialize(initialRoom("commons"));
const server = createRoomServer({ store });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function probe(name, method, path, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let status, bodyLen, bodyHead, err = null, setCookie = null;
  try {
    const res = await fetch(`${origin}${path}`, { method, headers, signal: ctl.signal });
    status = res.status;
    setCookie = res.headers.get("set-cookie");
    const text = await res.text();
    bodyLen = text.length;
    bodyHead = text.slice(0, 100);
  } catch (e) {
    err = e?.name === "AbortError" ? "TIMEOUT" : `FETCH-ERROR: ${e?.message}`;
  } finally { clearTimeout(timer); }
  return { name, method, status, bodyLen, bodyHead, err, setCookie };
}

// --- signup a real account ---
const slot = store.createAccountSessionSlot();
const signup = await probe("signup", "POST", "/api/auth/password/signup",
  { "Content-Type": "application/json", Origin: origin });
let cookie = null, csrf = null;
{
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/api/auth/password/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ email: "fuzz2@example.invalid", password: "fixture-password-2-long-enough",
        sessionToken: slot.token, sessionRevision: slot.session.sessionRevision }),
      signal: ctl.signal,
    });
    console.log("signup status:", res.status);
    const sc = res.headers.get("set-cookie") || "";
    const m = /account_session=([^;]+)/.exec(sc);
    if (m) { cookie = `account_session=${m[1]}`; const s = store.authenticateAccountSession(m[1]); csrf = s.csrf; }
  } finally { clearTimeout(timer); }
}
if (!cookie) { console.log("!! signup failed — cannot continue auth fuzz"); process.exit(2); }
console.log("got session cookie, csrf:", csrf ? "yes" : "no");

const results = [];
const GH = "/api/auth/github/link/start";
const UP = "/api/updates";
const BIG = "x".repeat(7000);
const C = cookie;

// --- 2b. github link/start, authenticated ---
results.push(await probe("gh-auth:get", "GET", GH, { Cookie: C }));
results.push(await probe("gh-auth:post", "POST", GH, { Cookie: C }));
results.push(await probe("gh-auth:head", "HEAD", GH, { Cookie: C }));
results.push(await probe("gh-auth:options", "OPTIONS", GH, { Cookie: C }));
results.push(await probe("gh-auth:tampered", "GET", GH, { Cookie: "account_session=" + C.slice(16).split("").reverse().join("") }));
results.push(await probe("gh-auth:truncated", "GET", GH, { Cookie: "account_session=" + C.slice(16, 30) }));
results.push(await probe("gh-auth:empty", "GET", GH, { Cookie: "account_session=" }));
results.push(await probe("gh-auth:giant", "GET", GH, { Cookie: "account_session=" + BIG }));
results.push(await probe("gh-auth:dupe", "GET", GH, { Cookie: `${C}; ${C}` }));
results.push(await probe("gh-auth:semi-inject", "GET", GH, { Cookie: `account_session=${C.slice(16)};evil=1` }));
results.push(await probe("gh-auth:query", "GET", GH + "?state=" + BIG.slice(0, 2000) + "&code=x", { Cookie: C }));
results.push(await probe("gh-auth:trail", "GET", GH + "/", { Cookie: C }));

// --- 3b. /api/updates via account cookie ---
results.push(await probe("upd-c:get", "GET", UP, { Cookie: C }));
results.push(await probe("upd-c:head", "HEAD", UP, { Cookie: C }));
results.push(await probe("upd-c:post", "POST", UP, { Cookie: C }));
results.push(await probe("upd-c:limit-bad", "GET", UP + "?limit=abc", { Cookie: C }));
results.push(await probe("upd-c:limit-huge", "GET", UP + "?limit=9999999999", { Cookie: C }));
results.push(await probe("upd-c:state-bad", "GET", UP + "?state=x", { Cookie: C }));
results.push(await probe("upd-c:cursor-bad", "GET", UP + "?cursor=zzz", { Cookie: C }));
results.push(await probe("upd-c:unknown", "GET", UP + "?zzz=1", { Cookie: C }));
results.push(await probe("upd-c:dup", "GET", UP + "?limit=1&limit=1", { Cookie: C }));
results.push(await probe("upd-c:tampered", "GET", UP, { Cookie: "account_session=deadbeef" }));
results.push(await probe("upd-c:dupe-cookie", "GET", UP, { Cookie: `${C}; ${C}` }));
results.push(await probe("upd-c:empty", "GET", UP, { Cookie: "account_session=" }));

for (const r of results) {
  const flag = r.err ? "!!" : "";
  if (r.err) console.log("!!", r.name, r.err);
  else console.log(`${flag}${r.status}\t${r.method}\t${r.name}\tlen=${r.bodyLen}\t${JSON.stringify(r.bodyHead)}`);
}
server.closeStreams();
server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
store.close();
rmSync(dir, { recursive: true, force: true });
