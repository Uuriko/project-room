// Public pages keep a 24px target on nav, list, and heading links without
// pulling a link out of the sentence around it. A bare `a` rule that sets
// display or min-height is the regression: every link in a paragraph
// becomes its own box.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoRoomView } from "../server/public-rooms.mjs";
import { renderReceiptsHtml } from "../server/receipts-page.mjs";
import { roomProofView } from "../server/proof-page.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const TAP = "nav a,li a,h2 a,a.block-link{display:inline-block;max-width:100%;min-height:24px}";

function styleOf(html) {
  const style = html.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(style, "page has a style block");
  return style[1];
}

function assertScopedTap(html, name) {
  const style = styleOf(html);
  const base = style.split("@media")[0];
  const bare = base.match(/(?:^|[\n}])a\{([^}]*)\}/);
  assert.ok(bare, `${name} keeps a color rule for links`);
  assert.doesNotMatch(bare[1], /min-height|display/, `${name} does not size every link`);
  assert.match(base, new RegExp(TAP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${name} sizes nav and list links`);
  assert.match(base, /p a:not\(\.block-link\)\{padding-block:4px\}/, `${name} pads a link that stays in a sentence`);
  assert.doesNotMatch(style, /@media\(pointer:coarse\)\{a\{/, `${name} does not flex every link on a coarse pointer`);
}

function proofHtml() {
  const directory = mkdtempSync(join(tmpdir(), "link-targets-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const now = "2026-10-11T00:00:00.000Z";
  store.db.prepare(`INSERT INTO public_rooms
      (slug, title, purpose, humans, agents, names_json, tasks_json, members_json, receipts_enabled, join_mode, join_token, owner_member_id, set_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "commons", "Commons", "A room that publishes its work.", 0, 1, "[]", "[]", "[]", 1, "request", null, "owner", now, now);
  try {
    return roomProofView(store, "commons").html;
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("public pages size nav and list links and leave a link inside a sentence inline", () => {
  const demo = demoRoomView().html;
  const receipts = renderReceiptsHtml({ receipts: [] });
  const proof = proofHtml();
  for (const [name, html] of [["demo", demo], ["receipts", receipts], ["proof", proof]]) assertScopedTap(html, name);
  assert.match(demo, /<p><a href="[^"]+">Start your own room<\/a> — sign in to join a real room\.<\/p>/);
  assert.doesNotMatch(demo, /block-link[^>]*>Start your own room/);
  assert.match(demo, /<header><nav><a href="\/">Project Room<\/a>/);
  assert.match(receipts, /<header><nav><a href="\/">Project Room<\/a><\/nav><\/header>/);
  const about = readFileSync(new URL("../about.html", import.meta.url), "utf8");
  const aboutBase = styleOf(about).split("@media")[0];
  assert.match(aboutBase, /nav a,li a,h2 a,a\.block-link,\.actions a:not\(\.start\)\{[^}]*min-height:24px/);
  assert.match(aboutBase, /main p a:not\(\.start\):not\(\.block-link\)\{[^}]*padding-block:4px/);
  assert.doesNotMatch(aboutBase, /(?:^|[\n}])a\{[^}]*(?:min-height|inline-block|inline-flex)/);
  const a11y = readFileSync(new URL("../src/public-a11y.css", import.meta.url), "utf8");
  assert.match(a11y, /\.join-page nav a,[\s\S]*?\.join-page a\.block-link \{\s*display: inline-block;[\s\S]*?min-height: 24px;/);
  assert.doesNotMatch(a11y, /p > a:only-child/);
  assert.doesNotMatch(a11y, /\.join-page a\s*\{[^}]*min-height/);
});

test("join, agent sign-in, and about open with a skip link", () => {
  for (const file of ["join.html", "agent-signin.html", "about.html"]) {
    const html = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const skip = html.indexOf('<a class="skip-link" href="#main">Skip to content</a>');
    const main = html.search(/<main\b[^>]*\bid="main"/);
    assert.ok(skip > -1, `${file} has a skip link`);
    assert.ok(main > skip, `${file} skip link comes before main`);
  }
});
