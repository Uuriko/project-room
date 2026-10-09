// WORKER 32 supplemental: account-cookie path on /api/updates (right cookie
// name, garbage token) + gmail callback with gmail service absent/present check.
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

const results = [];
let base = null;
async function req(name, method, path, { headers = {}, timeoutMs = 8000 } = {}) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
  let status = null, err = null; const t0 = Date.now();
  try { const r = await fetch(base + path, { method, headers, signal: c.signal }); status = r.status; await r.text(); }
  catch (e) { err = e.name === "AbortError" ? "TIMEOUT/HANG" : String(e).slice(0, 100); }
  clearTimeout(t);
  results.push({ name, method, path, status, ms: Date.now() - t0, err });
}
async function main() {
  const fixture = await createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const U = "/api/updates";
  await req("account cookie garbage", "GET", U, { headers: { Cookie: "account_session=garbage-token" } });
  await req("account cookie huge", "GET", U, { headers: { Cookie: "account_session=" + "x".repeat(4000) } });
  await req("account cookie empty", "GET", U, { headers: { Cookie: "account_session=" } });
  await req("account cookie sql-ish", "GET", U, { headers: { Cookie: "account_session=' OR '1'='1" } });
  await req("auth header empty bearer", "GET", U, { headers: { Authorization: "Bearer " } });
  await req("auth header no scheme", "GET", U, { headers: { Authorization: "garbage" } });
  await req("auth header basic", "GET", U, { headers: { Authorization: "Basic eHk=" } });
  // gmail callback: confirm gmail service is absent locally (result=error page)
  const r = await fetch(base + "/api/auth/gmail/callback?code=zz");
  const body = await r.text();
  console.log("gmail configured locally:", !body.includes("gmail=error"), "| status:", r.status);
  try { server.closeStreams(); server.closeAllConnections(); await new Promise(r2 => server.close(r2)); } catch {}
  try { fixture.store.close(); } catch {}
  console.log(JSON.stringify(results, null, 1));
}
main().catch(e => { console.error("FATAL", e); process.exit(2); });
