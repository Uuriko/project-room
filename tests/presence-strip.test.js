import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { presenceStripModel, renderPresenceStrip, STRIP_LIMIT } from "../src/presence-strip.js";

const members = {
  john: { id: "john", kind: "human", displayName: "John" },
  maya: { id: "maya", kind: "human", displayName: "Maya" },
  codex: { id: "codex", kind: "agent", displayName: "Codex", statusMessage: "stale text in the log" },
  grok: { id: "grok", kind: "agent", displayName: "Grok" },
  gone: { id: "gone", kind: "agent", displayName: "Gone", active: false }
};
const presence = new Map([
  ["john", { memberId: "john", state: "listening" }],
  ["maya", { memberId: "maya", state: "idle" }],
  ["codex", { memberId: "codex", state: "working", statusMessage: "running tests", workingOn: [{ workItemId: "invite", title: "Ship the invite flow" }] }],
  ["grok", { memberId: "grok", state: "listening", statusMessage: "drafting the 404 mockup" }]
]);

test("the strip leads with you, then live members, and says what each is on", () => {
  const model = presenceStripModel({ members, presence, selfId: "john" });
  assert.deepEqual(model.shown.map(e => [e.id, e.state, e.line]), [
    ["john", "listening", "here"],
    ["codex", "working", "on Ship the invite flow"],
    ["grok", "listening", "drafting the 404 mockup"],
    ["maya", "idle", "idle"]
  ]);
  assert.equal(model.live, 3);
  assert.equal(model.shown.find(e => e.id === "codex").workItemId, "invite");
  assert.ok(!model.shown.some(e => e.id === "gone"), "removed members never show");
});

test("a status line only shows while the member is live", () => {
  const quiet = new Map(presence);
  quiet.set("grok", { memberId: "grok", state: "idle", statusMessage: "drafting the 404 mockup" });
  const grok = presenceStripModel({ members, presence: quiet, selfId: "john" }).shown.find(e => e.id === "grok");
  assert.equal(grok.line, "idle");
});

test("working without a fresh session falls back to the status or label, never an old title", () => {
  const p = new Map(presence);
  p.set("codex", { memberId: "codex", state: "listening", workingOn: [] });
  const codex = presenceStripModel({ members, presence: p }).shown.find(e => e.id === "codex");
  assert.equal(codex.line, "here");
  assert.equal(codex.workItemId, null);
});

test("stale or missing presence shows names only, with no claims", () => {
  const stale = presenceStripModel({ members, presence, selfId: "john", stale: true });
  assert.ok(stale.shown.every(e => e.state === "unknown" && e.line === ""));
  const none = presenceStripModel({ members, presence: new Map() });
  assert.ok(none.shown.every(e => e.state === "unknown" && e.line === "no live signal"));
  assert.equal(presenceStripModel({ members: null }), null);
  assert.equal(renderPresenceStrip(null), "");
});

test("long rosters are capped with a count", () => {
  const many = { ...members };
  for (let i = 0; i < 10; i++) many[`a${i}`] = { id: `a${i}`, kind: "agent", displayName: `Agent ${i}` };
  const model = presenceStripModel({ members: many, presence, selfId: "john" });
  assert.equal(model.shown.length, STRIP_LIMIT);
  assert.equal(model.hidden, 14 - STRIP_LIMIT);
  assert.match(renderPresenceStrip(model), new RegExp(`\\+${14 - STRIP_LIMIT}<`));
});

test("rendered chips escape names and open the work or the member", () => {
  const html = renderPresenceStrip(presenceStripModel({ members: { ...members, grok: { ...members.grok, displayName: "<i>Grok</i>" } }, presence, selfId: "john" }));
  assert.doesNotMatch(html, /<i>Grok/);
  assert.match(html, /&lt;i&gt;Grok&lt;\/i&gt;/);
  assert.match(html, /data-open-work="invite"/);
  assert.match(html, /data-open-member="grok"/);
  assert.match(html, /<span class="ps-name">You<\/span>/);
});

test("the app mounts the strip under the room header", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<\/header>\s*<div id="presence-strip" class="presence-strip" aria-label="Who is here" hidden><\/div>/);
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /presenceStripModel\(\{ members: state\.members, presence: presenceStates, selfId: session\?\.member\?\.id \?\? null, stale: presenceStale \}\)/);
});
