import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { request } from "node:http";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

test("cookie namespace is a bounded cookie-name component", () => {
  for (const cookieNamespace of [null, 4, {}, "a b", "a;b", "a=b", "a\r\nb", "x".repeat(65)])
    assert.throws(() => createRoomServer({ store: {}, cookieNamespace }), /Cookie namespace/);
});

for (const secure of [false, true]) for (const namespace of ["", "sample_test-1"]) {
  test(`cookie scope: ${secure ? "HTTPS" : "loopback"} / ${namespace || "unchanged default"}`, async t => {
    const f = createAcceptanceFixture(), configured = secure ? "https://room.example.test" : null;
    const server = createRoomServer({ store: f.store, cookieNamespace: namespace, ...(configured ? { origin: configured } : {}) });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      f.store.close(); rmSync(f.directory, { recursive: true, force: true });
    });
    const address = "http://127.0.0.1:" + server.address().port, origin = configured ?? address;
    const send = (path, options = {}) => new Promise((resolve, reject) => {
      const req = request(address + path, { method: options.method ?? "GET",
        headers: { Host: new URL(origin).host, ...options.headers } }, res => {
        let body = ""; res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, headers: new Headers(res.headers), json: async () => JSON.parse(body) }));
      });
      req.on("error", reject); req.end(options.body);
    });
    const prefix = (secure ? "__Host-" : "") + (namespace ? namespace + "_" : "");
    const slot = await send("/api/account-session");
    assert.equal(slot.status, 200);
    const header = slot.headers.get("set-cookie"), cookie = header.split(";")[0];
    assert.ok(cookie.startsWith(prefix + "account_session="));
    assert.match(header, /; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+/);
    assert.equal(header.endsWith("; Secure"), secure);
    const state = await slot.json();
    const repeated = await send("/api/account-session", { headers: { Cookie: cookie } });
    assert.equal(repeated.headers.get("set-cookie"), null);
    assert.equal((await repeated.json()).sessionBinding, state.sessionBinding);
    const duplicate = await send("/api/account-session", { headers: { Cookie: cookie + "; " + cookie } });
    assert.equal(duplicate.status, 401);
    const login = await send("/api/session", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey: f.keys.owner }) });
    assert.equal(login.status, 201);
    const roomCookie = login.headers.get("set-cookie").split(";")[0];
    assert.ok(roomCookie.startsWith(prefix + "room_session="));
    assert.equal((await send("/api/session", { headers: { Cookie: roomCookie } })).status, 200);
    if (namespace) {
      const unscoped = roomCookie.replace(namespace + "_", "");
      assert.equal((await send("/api/session", { headers: { Cookie: unscoped } })).status, 401);
      // Unrelated cookies do not make the selected namespace ambiguous.
      assert.equal((await send("/api/session", { headers: { Cookie: unscoped + "; " + roomCookie } })).status, 200);
    }
  });
}
