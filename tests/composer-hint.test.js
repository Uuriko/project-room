// #1607: the message composer must visibly tell a human what to do next.
// The send pattern (Enter to send / Shift+Enter for a new line, tap-to-send
// on touch) was documented only in a `title` tooltip — invisible on touch.
// A stranger must be able to discover it from visible markup.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-composer-hint-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("composer omits the persistent keyboard instruction", async t => {
  const origin = await serve(t);
  const home = await (await fetch(`${origin}/`)).text();
  assert.doesNotMatch(home, /id="composer-hint"|id="friend-dm-hint"/);
  assert.doesNotMatch(home, /Enter to send · Shift \+ Enter for a new line/);
});

test("coarse-pointer composer controls hit the 44px touch target", async t => {
  const origin = await serve(t);
  const css = await (await fetch(`${origin}/src/styles.css`)).text();
  assert.match(css, /@media\s*\(pointer:\s*coarse\)\s*\{[\s\S]{0,400}?\.composer-add[\s\S]{0,200}?44px/, "composer-add reaches 44px on coarse pointers");
  assert.match(css, /@media\s*\(pointer:\s*coarse\)\s*\{[\s\S]{0,400}?\.suggestion-chip[\s\S]{0,200}?44px/, "suggestion chips reach 44px on coarse pointers");
});
