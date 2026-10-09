// WORKER 32 supplemental 2: cookie-auth path WITH valid-format binding so we
// reach authenticateAccountSession; expect 401 for garbage token (not 422/500).
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
let base = null;
async function req(name, path, headers = {}) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 8000);
  let status = null, body = "", err = null;
  try { const r = await fetch(base + path, { headers, signal: c.signal }); status = r.status; body = (await r.text()).slice(0, 200); }
  catch (e) { err = e.name === "AbortError" ? "TIMEOUT" : String(e).slice(0, 80); }
  clearTimeout(t);
  console.log(JSON.stringify({ name, status, err, body: body.replace(/\n/g, " ") }));
}
async function main() {
  const fixture = await createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const B = "a".repeat(64);
  const U = "/api/updates";
  await req("cookie garbage + binding header", U, { Cookie: "account_session=garbage-token", "x-session-binding": B });
  await req("cookie garbage + binding query", U + "?binding=" + B, { Cookie: "account_session=garbage-token" });
  await req("cookie garbage + bad binding", U + "?binding=zzz", { Cookie: "account_session=garbage-token" });
  await req("cookie garbage + both bindings differ", U + "?binding=" + "b".repeat(64), { Cookie: "account_session=garbage-token", "x-session-binding": B });
  // health after
  const h = await fetch(base + "/api/health"); console.log("health:", h.status);
  try { server.closeStreams(); server.closeAllConnections(); await new Promise(r2 => server.close(r2)); } catch {}
  try { fixture.store.close(); } catch {}
}
main().catch(e => { console.error("FATAL", e); process.exit(2); });
