// One token set on every surface that cannot import src/design-tokens.js.
// Those pages embed DARK_DECLARATIONS and LIGHT_DECLARATIONS verbatim.
// A drift back to a private palette (acid door, clay door, cream about,
// terracotta offers) fails here. Contrast lives in scripts/design-contrast-check.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DARK_DECLARATIONS, LIGHT_DECLARATIONS } from "../src/design-tokens.js";
import { ROOM_ENTRY_HTML, publicRoomDoorHtml } from "../deploy/room-entry.mjs";
import { renderReceiptsHtml } from "../server/receipts-page.mjs";
import { renderRoomExportHtml } from "../server/room-export-html.mjs";
import { PublicFace, roomPublicFaceSchema } from "../server/public-face.mjs";
import { HEALTH_PAGE_STYLE } from "../scripts/room-health.mjs";

const RETIRED = /#dfff00|#0B120F|#070608|#fafaf7|#205bb0|#dc673e/i;

function faceHtml() {
  const db = new DatabaseSync(":memory:");
  db.exec(roomPublicFaceSchema);
  const store = {
    db,
    transaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      try { const out = fn(); db.exec("COMMIT"); return out; }
      catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    },
    room() {
      return { state: { room: { id: "r1", title: "Room", purpose: "Work", ownerId: "owner" }, members: { owner: { id: "owner", displayName: "Owner", active: true, kind: "human", permissions: [] } }, messages: [] } };
    }
  };
  const face = new PublicFace(store);
  return face.faceHtml(face.enable("r1", "owner").publicCode);
}

const receipts = renderReceiptsHtml({
  generatedAt: "2026-10-01T00:00:00.000Z",
  board: "board",
  boardUrl: null,
  commentsScanned: 0,
  upstreamMain: null,
  totals: { receipts: 0, verified: 0, failed: 0, open: 0, reported: 0 },
  perLane: [],
  receipts: []
});

const surfaces = {
  "styles.css": readFileSync(new URL("../src/styles.css", import.meta.url), "utf8"),
  "about.html": readFileSync(new URL("../about.html", import.meta.url), "utf8"),
  "project-offers.css": readFileSync(new URL("../src/project-offers.css", import.meta.url), "utf8"),
  "demigod door": ROOM_ENTRY_HTML,
  "public door": publicRoomDoorHtml(),
  "public face": faceHtml(),
  receipts,
  "room export": renderRoomExportHtml([]),
  "room health": readFileSync(new URL("../docs/room-health.html", import.meta.url), "utf8")
};

test("every surface embeds the same dark and light tokens", () => {
  for (const [name, html] of Object.entries(surfaces)) {
    assert.ok(html.includes(DARK_DECLARATIONS), `${name} is missing the dark tokens`);
    assert.ok(html.includes(LIGHT_DECLARATIONS), `${name} is missing the light tokens`);
    assert.doesNotMatch(html, RETIRED, `${name} still ships a retired palette`);
  }
  assert.ok(surfaces["room health"].includes(HEALTH_PAGE_STYLE), "published room health page uses the generator stylesheet");
});
