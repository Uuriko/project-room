// #1607: the message composer must visibly tell a human what to do next.
// The send pattern (Enter to send / Shift+Enter for a new line, tap-to-send
// on touch) was documented only in a `title` tooltip — invisible on touch.
// A stranger must be able to discover it from visible markup.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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

test("composer has a visible, plain-language send hint (not tooltip-only)", async t => {
  const origin = await serve(t);
  const home = await (await fetch(`${origin}/`)).text();
  const hint = home.match(/<p[^>]*id="composer-hint"[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(hint, "expected a visible #composer-hint element in the composer markup");
  const tag = hint[0].slice(0, hint[0].indexOf(">") + 1);
  assert.doesNotMatch(tag, /\bsr-only\b/, "#composer-hint must be visible, not screen-reader-only");
  assert.doesNotMatch(tag, /\bhidden\b/, "#composer-hint must not be hidden by default");
  assert.match(hint[1], /Enter to send/i, "#composer-hint states how to send in plain language");
  assert.match(hint[1], /Shift \+ Enter|new line/i, "#composer-hint states how to make a new line");
  // The hint is wired to the textarea so screen readers announce it too.
  assert.match(home, /id="message-input"[^>]*aria-describedby="[^"]*composer-hint/, "textarea aria-describedby references #composer-hint");
  // The touch/desktop text swap must reach the visible hint, not only the tooltip.
  const app = readFileSync(join(import.meta.dirname, "..", "src", "app.js"), "utf8");
  assert.match(app, /composer-hint/, "src/app.js syncs the visible hint text");
  assert.match(app, /composer-hint[\s\S]{0,120}?textContent\s*=\s*hint/, "syncComposerHint writes the visible hint text");
});

test("coarse-pointer composer controls hit the 44px touch target", async t => {
  const origin = await serve(t);
  const css = await (await fetch(`${origin}/src/styles.css`)).text();
  assert.match(css, /@media\s*\(pointer:\s*coarse\)\s*\{[\s\S]{0,400}?\.composer-add[\s\S]{0,200}?44px/, "composer-add reaches 44px on coarse pointers");
  assert.match(css, /@media\s*\(pointer:\s*coarse\)\s*\{[\s\S]{0,400}?\.suggestion-chip[\s\S]{0,200}?44px/, "suggestion chips reach 44px on coarse pointers");
});
