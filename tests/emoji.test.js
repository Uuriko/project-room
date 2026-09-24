import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { mentionHtml } from "../src/conversation.js";
import { setTier } from "../server/autonomy-tiers.mjs";
import { canonicalReaction, clipGraphemes, emojiCatalog, emojiMatches, emojiQuery, insertEmoji, isSingleEmoji, renderEmojiShortcodes, MAX_REACTIONS_PER_MESSAGE } from "../src/emoji.js";

const HEART = "\u2764\uFE0F";
const LIKE = "\u{1F44D}";
const FIRE = "\u{1F525}";
const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
const FLAG = "\u{1F1FA}\u{1F1F8}";
const TONED = "\u{1F44D}\u{1F3FD}";
const esc = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

function room(t) {
  const directory = mkdtempSync(join(tmpdir(), "emoji-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const send = (key, type, data, id = crypto.randomUUID()) => store.command(key, "commons", { id, type, data });
  send(owner, T.MEMBER_ADDED, { memberId: "human", displayName: "Maya", kind: "human", permissions: [] });
  send(owner, T.MEMBER_ADDED, { memberId: "agent", displayName: "Room agent", kind: "agent", permissions: [] });
  // Graduated autonomy tiers: the fixture agent is operator-promoted so the
  // emoji tests exercise it as a working agent.
  setTier(store.db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const human = store.issueAccessKey("commons", "human");
  const agent = store.issueAccessKey("commons", "agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, owner, human, agent, send };
}

test("unicode emoji in a message body round-trips and shortcodes render without breaking mentions", t => {
  const f = room(t);
  const body = `Ship it ${TONED} ${FAMILY} ${FLAG}`;
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "glyph", body });
  assert.equal(f.store.snapshot(f.owner, "commons").state.messages.at(-1).body, body);
  const members = [{ id: "agent", displayName: "Room agent", kind: "agent" }];
  const html = mentionHtml(`Hey @Room agent ${body} :fire: :not_a_real_emoji_zzz:`, members, esc);
  assert.match(html, /data-mention-id="agent"/);
  assert.match(html, new RegExp(TONED));
  assert.match(html, new RegExp(FAMILY));
  assert.match(html, new RegExp(FLAG));
  assert.match(html, new RegExp(FIRE));
  assert.match(html, /:not_a_real_emoji_zzz:/);
  assert.equal(html.includes("<script>"), false);
  assert.equal(renderEmojiShortcodes(":smile:"), "😄");
  assert.equal(renderEmojiShortcodes("note: not a shortcode"), "note: not a shortcode");
  assert.equal(clipGraphemes(`xx${FLAG}`, 3), "xx");
  assert.equal(clipGraphemes(FLAG, 2), "");
});

test("reaction identity is the unicode glyph; legacy names and shortcodes are aliases", t => {
  assert.equal(canonicalReaction("like"), LIKE);
  assert.equal(canonicalReaction("thumbsup"), LIKE);
  assert.equal(canonicalReaction(":+1:"), LIKE);
  assert.equal(canonicalReaction(LIKE), LIKE);
  assert.equal(canonicalReaction("heart"), HEART);
  assert.equal(canonicalReaction("\u2764"), HEART);
  assert.equal(canonicalReaction("celebrate"), "🎉");
  assert.equal(canonicalReaction("tada"), "🎉");
  assert.equal(canonicalReaction("thinking"), "🤔");
  assert.equal(canonicalReaction("thinking_face"), "🤔");
  assert.equal(canonicalReaction(":fire:"), FIRE);
  assert.equal(canonicalReaction("fire"), FIRE);
  assert.equal(canonicalReaction(TONED), TONED);
  assert.notEqual(canonicalReaction(TONED), LIKE);
  assert.equal(canonicalReaction("thumbsup::skin-tone-4"), TONED);
  assert.equal(canonicalReaction(":thumbsup::skin-tone-4:"), TONED);
  assert.equal(canonicalReaction("fire::skin-tone-4"), null);
  assert.equal(canonicalReaction(FAMILY), FAMILY);
  assert.equal(canonicalReaction(FLAG), FLAG);
  assert.equal(isSingleEmoji(FAMILY), true);
  assert.equal(isSingleEmoji(FLAG), true);
  assert.equal(canonicalReaction("🔥👍"), null);
  assert.equal(canonicalReaction("unbounded-choice"), null);
  assert.equal(canonicalReaction("hello"), null);
  assert.equal(canonicalReaction(""), null);
  const f = room(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "topic", body: "Friday" });
  f.send(f.human, T.MESSAGE_REACTION_SET, { messageId: "topic", reaction: "like", active: true });
  f.send(f.agent, T.MESSAGE_REACTION_SET, { messageId: "topic", reaction: LIKE, active: true });
  f.send(f.owner, T.MESSAGE_REACTION_SET, { messageId: "topic", reaction: ":fire:", active: true });
  const reactions = f.store.snapshot(f.owner, "commons").state.messages.find(m => m.id === "topic").reactions;
  assert.deepEqual(reactions[LIKE], ["agent", "human"]);
  assert.deepEqual(reactions[FIRE], ["owner"]);
  assert.equal(reactions.like, undefined);
  f.send(f.human, T.MESSAGE_REACTION_SET, { messageId: "topic", reaction: "thumbsup", active: false });
  const after = f.store.snapshot(f.owner, "commons").state.messages.find(m => m.id === "topic").reactions;
  assert.deepEqual(after[LIKE], ["agent"]);
  assert.equal(after.heart, undefined);
});

test("a message accepts one reaction per member per emoji and stops at the distinct cap", t => {
  const f = room(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "topic", body: "cap" });
  const glyphs = emojiCatalog().flatMap(group => group.items.map(item => item.emoji));
  const distinct = [];
  for (const glyph of ["👍", "❤️", "🎉", "🤔", "😂", "🔥", "👀", "✅", ...glyphs]) {
    if (distinct.includes(glyph)) continue;
    distinct.push(glyph);
    if (distinct.length === MAX_REACTIONS_PER_MESSAGE) break;
  }
  assert.equal(distinct.length, MAX_REACTIONS_PER_MESSAGE);
  for (const glyph of distinct) f.send(f.human, T.MESSAGE_REACTION_SET, { messageId: "topic", reaction: glyph, active: true });
  const before = f.store.snapshot(f.owner, "commons");
  assert.equal(Object.keys(before.state.messages.find(m => m.id === "topic").reactions).length, MAX_REACTIONS_PER_MESSAGE);
  const extra = glyphs.find(glyph => !distinct.includes(glyph));
  assert.ok(extra);
  assert.throws(() => f.send(f.human, T.MESSAGE_REACTION_SET, { messageId: "topic", reaction: extra, active: true }), /Too many reactions/);
  assert.deepEqual(f.store.snapshot(f.owner, "commons"), before);
  f.send(f.human, T.MESSAGE_REACTION_SET, { messageId: "topic", reaction: distinct[0], active: true });
  f.send(f.agent, T.MESSAGE_REACTION_SET, { messageId: "topic", reaction: distinct[0], active: true });
  const shared = f.store.snapshot(f.owner, "commons").state.messages.find(m => m.id === "topic").reactions[distinct[0]];
  assert.deepEqual(shared, ["agent", "human"]);
});

test("composer :shortcode query inserts the glyph and leaves @mentions alone", () => {
  const found = emojiQuery("hello :fir", 11);
  assert.equal(found.query, "fir");
  assert.equal(emojiQuery("Note:", 5), null);
  assert.equal(emojiQuery("hi @Maya", 8), null);
  const matches = emojiMatches("fir", 8);
  assert.equal(matches[0].emoji, FIRE);
  const inserted = insertEmoji("hello :fir", 11, found.start, matches[0].emoji);
  assert.equal(inserted.body, `hello ${FIRE} `);
  assert.equal(inserted.body.includes(":fir"), false);
  assert.equal(emojiMatches("zzzz-not-emoji", 8).length, 0);
});
