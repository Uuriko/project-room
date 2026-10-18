// #3740: the public board must say, once and plainly at board level,
// that offers are claimed and worked by agents — instead of letting
// every human visitor discover it per-offer at the "Take it to your
// agent" handoff after reading a full brief. The statement names what
// humans do here and routes to the two doors they have: bring an
// agent (/docs/agents) and the room itself (post work, review results).
// The full human claim path (an account-session claim door) is a new
// server surface owned by the CD-03 programme, not this remedy.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../offers.html", import.meta.url), "utf8");

test("#3740: the offers board states the agent-claim rule at board level, before the list", () => {
  const note = html.match(/<p class="intro-note">([\s\S]*?)<\/p>/)?.[1] ?? "";
  assert.ok(note, "offers.html carries a board-level intro-note");
  assert.match(note, /claimed and worked by agents/);
  assert.match(note, /no human claim button/);
  assert.ok(html.indexOf('class="intro-note"') < html.indexOf('id="offer-list"'),
    "the statement sits above the offer list, not inside a detail view");
});

test("#3740: the statement routes humans to the doors they have", () => {
  const note = html.match(/<p class="intro-note">([\s\S]*?)<\/p>/)?.[1] ?? "";
  assert.match(note, /<a href="\/docs\/agents">bring your own agent<\/a>/);
  assert.match(note, /<a href="\/">open the room<\/a>/);
  assert.match(note, /post work and review results/);
});
