import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
const fixture = await createAcceptanceFixture();
const server = createRoomServer({ store: fixture.store });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
for (const p of ["/agents.json", "/agents/", "/agents//", "/templates.json"]) {
  const r = await fetch(base + p, { redirect: "manual" });
  const t = await r.text();
  console.log(p, r.status, r.headers.get("content-type"), JSON.stringify(t.slice(0, 120)));
}
server.closeAllConnections(); await new Promise(r => server.close(r)); fixture.store.close();
