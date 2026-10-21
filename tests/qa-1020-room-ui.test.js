import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { emptyTimelineHtml } from "../src/conversation.js";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const share = readFileSync(new URL("../src/share-links.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("a since_join guest is told earlier messages are hidden, and gets no Invite", () => {
  const guest = emptyTimelineHtml({ historyHidden: true, canInvite: false });
  assert.match(guest, /Messages from before you joined are hidden/);
  assert.doesNotMatch(guest, /No messages yet/);
  assert.doesNotMatch(guest, /data-empty-invite/);
  const owner = emptyTimelineHtml({ historyHidden: false, canInvite: true });
  assert.match(owner, /No messages yet\./);
  assert.match(owner, /data-empty-invite/);
  assert.match(app, /memberHistoryVisibility\(state, session\.member\.id\) === "since_join"/);
  assert.match(app, /!\$\("#invite-people-button"\)\.hidden/, "Invite shortcut follows the real Invite button");
});

test("action choices (recipient, assignee, reviewer, producer) keep the full member identity", () => {
  // Kept from main: a picker decides who gets a private message or credit, so
  // it shows "Name (id)" even when names are unique (quiet-attribution check).
  assert.match(app, /\$\{esc\(memberLabel\(m\.id\)\)\} · \$\{esc\(kindLabel/);
  assert.match(app, /\$\{esc\(memberLabel\(member\.id\)\)\} · \$\{esc\(kindLabel/);
});

test("room Settings no longer shows the signed-out Create Room disclosure", () => {
  assert.doesNotMatch(html, /id="create-room-details"/);
  assert.doesNotMatch(app, /#create-room-details/);
});

test("an archived room hides Invite", () => {
  assert.match(share, /\|\| Boolean\(getState\(\) && isRoomArchived\(getState\(\)\)\)/);
});

test("section summaries in panel headers stay left aligned when the chip is empty", () => {
  assert.match(css, /\.panel-header\.section-summary \{ justify-content: flex-start; \}/);
});
