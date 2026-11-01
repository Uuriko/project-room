import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { agentDirectoryView, demoRoomView, templatesIndex } from "../server/public-rooms.mjs";
import { renderReceiptsHtml } from "../server/receipts-page.mjs";

// UT wave-2 candidate 20, residual legs (L9-a11y):
// (i) the public templates rendered their action links at 23px on a phone
//     (lane 10-01 F2, rendered) while the receipts template in the same
//     family already gives coarse-pointer links the product's 44px floor
//     (min-height: var(--control-min-target-coarse) = 2.75rem);
// (ii) the same templates had no focus style at all, so keyboard focus fell
//     back to the thin UA-default outline (lane 10-03 F5), while the app
//     standard is a solid 2px outline in the product blue (#a9b9ff,
//     src/styles.css) at a 2px offset;
// (iii) /join labelled two different fields "Room link" (lanes 10-03 F4b,
//     10-04 F4c): the code-entry field takes an invite link or code, the
//     request-access field takes a room link — one accessible name each.

const COARSE_44 = /@media\(pointer:coarse\)\{a\{display:inline-flex;align-items:center;min-height:44px\}\}/;
const PUBLIC_FOCUS = /:focus-visible\{outline:2px solid #a9b9ff;outline-offset:2px\}/;

async function publicRoomsPages(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-public-a11y-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RoomStore(join(directory, "room.sqlite"));
  return [
    ["agents directory", agentDirectoryView(store, {}).html],
    ["templates index", templatesIndex().html],
    ["demo room", demoRoomView({}).html],
  ];
}

test("public templates (public-rooms family) give coarse-pointer links the 44px floor", async t => {
  for (const [name, html] of await publicRoomsPages(t)) {
    assert.match(html, COARSE_44, `${name}: coarse-pointer links are inline-flex with a 44px min-height, mirroring the receipts template`);
  }
});

test("public templates (public-rooms family) carry the product focus outline, not the UA default", async t => {
  for (const [name, html] of await publicRoomsPages(t)) {
    assert.match(html, PUBLIC_FOCUS, `${name}: :focus-visible uses the app's 2px solid #a9b9ff outline at 2px offset`);
  }
});

test("receipts template keeps its 44px coarse floor and gains the product focus outline", () => {
  const html = renderReceiptsHtml({ receipts: [], nextCursor: null });
  assert.match(html, /@media\(pointer:coarse\)\{a\{display:inline-flex;align-items:center;min-height:var\(--control-min-target-coarse\)\}/,
    "receipts: existing coarse-pointer 44px floor (the pattern the other public templates mirror) is unchanged");
  assert.match(html, /:focus-visible\{outline:2px solid var\(--blue\);outline-offset:2px\}/,
    "receipts: :focus-visible uses the app's 2px solid outline (var(--blue) is #a9b9ff in this template's tokens) at 2px offset");
});

test("/join gives its two link fields distinct labels", () => {
  const html = readFileSync(new URL("../join.html", import.meta.url), "utf8");
  const labelFor = id => {
    const match = new RegExp(`<label>([^<]+)\\s*<input id="${id}"`).exec(html);
    assert.ok(match, `${id} is wrapped in a label with text`);
    return match[1].trim();
  };
  const entry = labelFor("join-enter-code");
  const request = labelFor("join-request-room");
  assert.notEqual(entry, request, "the code-entry field and the request-access room field must not share one accessible name");
  assert.equal(entry, "Invite link or code", "the entry field takes an invite link or an RM- code, and its label says so");
  assert.equal(request, "Room link", "the request-access field keeps the room-link label its hint text describes");
});
