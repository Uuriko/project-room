# W27-01 minimal repro — wrong-method answers 404 instead of 405 (minor, advisory)

Boot a local server (acceptance fixture) and hit either shard route with a
wrong method:

```sh
cd ~/workspace/pr-wave2000-guild-02
TMPDIR=$PWD/.tmp node -e "
import('./scripts/acceptance-fixture.mjs').then(async (m) => {
  const f = await m.createAcceptanceFixture();
  const { createRoomServer } = await import('./server/http.mjs');
  const server = createRoomServer({ store: f.store });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const path of ['/api/auth/agent/rooms', '/api/share-links/join'])
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const r = await fetch(base + path, { method, headers: { origin: base } });
      console.log(r.status, method, path, '| Allow:', r.headers.get('allow'));
    }
  process.exit(0);
});" 2>/dev/null
```

Observed (2026-10-09): every combination returns **404** `{"error":{"code":"not_found"...}}`
with no `Allow` header. Sibling POST-only routes in the same file
(`/api/share-links/join-agent`, `/api/agent-identities`,
`/api/opportunities.json`, `/api/public/rooms/directory`, `/api/updates`,
`/receipts`) carry an explicit 405 guard; the join-agent guard's comment
states the design intent: "a wrong method is 405 (Allow: POST), not a 404
unknown-route, so a mistaken GET reads as a method error."

Fail-first test: `worker-27/method-405.test.js` (fails now: `GET
/api/auth/agent/rooms: expected 405, got 404`; passes once 405 guards land).

Severity: minor consistency nit. Not a doc violation (openapi.yaml lists no
405 for these routes), no security impact (405 confirms the route exists
either way). Suggested fix, mirroring the join-agent guard, in server/http.mjs:

```js
if (url.pathname === "/api/auth/agent/rooms" && req.method !== "POST") {
  reject(405, "method_not_allowed", "Method not allowed", { Allow: "POST" });
}
if (url.pathname === "/api/share-links/join" && req.method !== "POST") {
  reject(405, "method_not_allowed", "Method not allowed", { Allow: "POST" });
}
```

(placed directly after each route's POST block, like the existing join-agent guard).
