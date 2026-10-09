// Minimal repro for W6-01: unsupported methods on /api/account-rooms return 404, not 405.
// Run: node worker-6/repro-405.mjs
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

const fixture = await createAcceptanceFixture();
const server = createRoomServer({ store: fixture.store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

for (const m of ["PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
  const r = await fetch(base + "/api/account-rooms", { method: m });
  console.log(m, "->", r.status, "(expected 405)");
  await r.text().catch(() => {});
}
// Sibling route for contrast (codebase convention):
const s = await fetch(base + "/api/public-work/match", { method: "GET" });
console.log("GET /api/public-work/match ->", s.status, "(405 convention)");

server.closeStreams(); server.closeAllConnections();
await new Promise(r => server.close(r));
fixture.store.close();
