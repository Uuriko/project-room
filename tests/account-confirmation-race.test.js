// Delayed account-confirmation race (PR #1401 regression).
//
// Deterministic HTTP-level companion to the browser test "account-only
// confirmation preserves a newer login and retires a held private preview"
// (scripts/inbox-browser-check.mjs): the browser harness stages this race
// unreliably on loaded runners — focus-event dispatch is browser-dependent
// in headless multi-page runs, the client's 10s request deadline loses to
// slow runners, and the second-tab login/room/reload sequence fails in
// three independent timing modes (the 2026-10-06 quarantine entry; sibling
// PR #1729 owns the harness repair per first-claim-wins). The product
// contract needs none of that: hold the confirmation GET at the HTTP
// layer, complete a newer login on the same slot, release, and assert the
// stale confirmation answers 401 without touching the cookie jar. Runs in
// ~3s, no browser, no timers.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

async function launch(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-confirmation-race-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, server, origin };
}

const cookie = token => `account_session=${token}`;

test("a held account confirmation cannot displace a newer login", async t => {
  const f = await launch(t);
  f.store.createAccount("account-a"); f.store.completeOnboarding("account-a");
  f.store.createAccount("account-b"); f.store.completeOnboarding("account-b");
  const keyA = f.store.issueAccountAccessKey("account-a");
  const keyB = f.store.issueAccountAccessKey("account-b");
  const slot = f.store.createAccountSessionSlot();
  const sessionA = f.store.loginAccountSession(slot.token, keyA, 0);
  const bindingA = sessionA.sessionBinding;

  const slotView = async token => (await (await fetch(`${f.origin}/api/account-session`, {
    headers: { Cookie: cookie(token) },
  })).json());

  // Hold the bound confirmation read at the raw HTTP layer, exactly as the
  // browser harness did — but release it deterministically, with no client
  // request deadline involved.
  const raw = f.server.listeners("request")[0];
  f.server.removeListener("request", raw);
  let releaseHold = () => {};
  const captured = new Promise(resolve => {
    f.server.on("request", (request, response) => {
      if (request.method === "GET" && request.url === "/api/account-session"
        && request.headers["x-session-binding"] === bindingA) {
        resolve();
        return new Promise(done => { releaseHold = done; }).then(() => raw(request, response));
      }
      return raw(request, response);
    });
  });

  const confirmation = fetch(`${f.origin}/api/account-session`, {
    headers: { Cookie: cookie(slot.token), "X-Session-Binding": bindingA },
  });
  await captured;

  // A newer login lands on the same browser slot while the confirmation is
  // held. The login rotates the slot token (QAS-702), killing the old one.
  const before = await slotView(slot.token);
  assert.equal(before.authenticated, true);
  assert.equal(before.account.id, "account-a");
  const login = await fetch(`${f.origin}/api/account-session`, {
    method: "POST",
    headers: {
      Origin: f.origin,
      "Content-Type": "application/json",
      Cookie: cookie(slot.token),
      "X-CSRF-Token": before.csrf,
      "X-Session-Binding": before.sessionBinding,
    },
    body: JSON.stringify({ accountAccessKey: keyB, expectedSessionRevision: before.sessionRevision }),
  });
  assert.equal(login.status, 201, await login.text());
  const freshToken = /account_session=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(freshToken, "login rotates the slot cookie");
  assert.notEqual(freshToken, slot.token);

  // Release the stale confirmation: its slot token died with the rotation,
  // so it must answer 401 — and must not set any cookie that could clobber
  // the newer login.
  releaseHold();
  const held = await confirmation;
  assert.equal(held.status, 401, await held.text());
  assert.equal(held.headers.get("set-cookie"), null, "stale confirmation sets no cookie");

  // The newer login is intact.
  const current = await slotView(freshToken);
  assert.equal(current.authenticated, true);
  assert.equal(current.account.id, "account-b");
});
