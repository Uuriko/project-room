// WCAG 2.5.8: public links are at least 24px on a fine pointer. The 44px
// coarse-pointer floor does not apply in headless Chrome at 375px, so the
// floor has to be in the base rule, not only inside @media (pointer: coarse).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-tap-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function baseStyle(html) {
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
  return style.split("@media")[0];
}

function assertLinkFloor(html, path) {
  assert.match(baseStyle(html), /a\{[^}]*min-height:\s*24px/, `${path} base link rule is at least 24px`);
}

test("public acquisition and receipt pages give links a 24px target on a fine pointer", async t => {
  const origin = await serve(t);
  for (const path of ["/agents", "/demo", "/receipts"]) {
    assertLinkFloor(await (await fetch(origin + path)).text(), path);
  }
  const directory = mkdtempSync(join(tmpdir(), "project-room-tap-proof-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO public_rooms
      (slug, title, purpose, humans, agents, names_json, tasks_json, members_json, receipts_enabled, join_mode, join_token, owner_member_id, set_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "commons", "Commons", "A room that publishes its work.", 0, 1, "[]", "[]", "[]",
    1, "request", null, "owner", now, now);
  const proofServer = createRoomServer({ store });
  await new Promise(resolve => proofServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    proofServer.closeStreams(); proofServer.closeAllConnections();
    await new Promise(resolve => proofServer.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const proofOrigin = `http://127.0.0.1:${proofServer.address().port}`;
  const proof = await fetch(proofOrigin + "/r/commons/proof");
  assert.equal(proof.status, 200);
  assertLinkFloor(await proof.text(), "/r/commons/proof");
  const a11y = await (await fetch(origin + "/src/public-a11y.css")).text();
  const withoutCoarse = a11y.replace(/@media\s*\(\s*pointer:\s*coarse\s*\)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
  assert.match(withoutCoarse, /\.join-page a\s*\{[^}]*min-height:\s*24px/, "join links are at least 24px without a coarse pointer");
});
