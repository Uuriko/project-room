import test from "node:test";
import assert from "node:assert/strict";
import { createBodyHtmlCache, messageBodyHtml } from "../src/conversation.js";

// Chat renders re-run for every arrival. The body HTML (emoji, @mention chips,
// markdown) is pure in the body, the message id and the mentionable members,
// so a render pass over unchanged history must not re-render those bodies.
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const members = () => [
  { id: "ada", displayName: "Ada", kind: "human" },
  { id: "bot", displayName: "Room Bot", kind: "agent" }
];
const history = Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, body: i % 7 ? `**note ${i}** for @Ada see https://example.com/${i}` : `line\n`.repeat(20) }));

function counting() {
  let calls = 0;
  const cache = createBodyHtmlCache((...args) => { calls++; return messageBodyHtml(...args); });
  return { cache, calls: () => calls };
}

test("cached body HTML is byte-identical to messageBodyHtml", () => {
  const { cache } = counting();
  const roster = members();
  for (const m of history) assert.equal(cache.html(m.body, roster, esc, m.id), messageBodyHtml(m.body, roster, esc, m.id));
});

test("a second render pass over unchanged history renders no bodies", () => {
  const { cache, calls } = counting();
  for (const m of history) cache.html(m.body, members(), esc, m.id);
  assert.equal(calls(), history.length);
  // Each pass builds a fresh members array (Object.values(state.members)).
  const roster = members();
  for (const m of [...history, { id: "new", body: "hi @Room Bot" }]) cache.html(m.body, roster, esc, m.id);
  assert.equal(calls(), history.length + 1, "only the new arrival is rendered");
});

test("an edited body or a renamed member re-renders", () => {
  const { cache, calls } = counting();
  const roster = members();
  assert.match(cache.html("hey @Ada", roster, esc, "x"), /data-mention-id="ada"/);
  assert.equal(cache.html("hey @Ada!", roster, esc, "x"), messageBodyHtml("hey @Ada!", roster, esc, "x"));
  assert.equal(calls(), 2);
  const renamed = [{ id: "ada", displayName: "Ada L", kind: "human" }, roster[1]];
  assert.doesNotMatch(cache.html("hey @Ada", renamed, esc, "x"), /data-mention-id="ada"/);
  assert.equal(calls(), 3);
  // A different id with the same body keeps its own expansion focus key.
  const long = "row\n".repeat(30);
  assert.match(cache.html(long, renamed, esc, "a"), /message-expand:a/);
  assert.match(cache.html(long, renamed, esc, "b"), /message-expand:b/);
});

test("members mutated in place still invalidate (state.members is mutated by the reducer)", () => {
  const { cache } = counting();
  const state = { members: Object.fromEntries(members().map(m => [m.id, m])) };
  assert.match(cache.html("ping @Ada", Object.values(state.members), esc, "y"), /data-mention-id="ada"/);
  state.members.ada.displayName = "Ada Two";
  assert.doesNotMatch(cache.html("ping @Ada", Object.values(state.members), esc, "y"), /data-mention-id="ada"/);
});
