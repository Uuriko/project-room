import test from "node:test";
import assert from "node:assert/strict";
import { createResultComparison } from "../src/result-comparison.js";

function fixture() {
  const pending = [], state = { messages: [] };
  const box = { hidden: true, innerHTML: "", textContent: "", replaceChildren() { this.innerHTML = ""; this.textContent = ""; } };
  const controller = createResultComparison({ getState: () => state,
    client: { workResult: () => new Promise(resolve => pending.push(resolve)) },
    esc: text => String(text).replaceAll("<", "&lt;").replaceAll(">", "&gt;") });
  const respond = (index, body = "old") => pending[index]({ result: { receipt: { eventId: "previous" }, text: { messageId: "old-message", body } } });
  const load = () => controller.load("work", "previous", { messageId: "current", body: "new" }, box, () => true);
  return { controller, state, box, respond, load, pending };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("cleared or replaced comparisons ignore late reads", async () => {
  const f = fixture(); f.load(); f.controller.clear(f.box); f.respond(0); await settle();
  assert.equal(f.box.hidden, true); assert.equal(f.box.innerHTML, "");
  f.load(); f.load(); f.respond(1, "stale"); await settle(); assert.equal(f.box.innerHTML, "");
  f.respond(2, "fresh"); await settle(); assert.match(f.box.innerHTML, /fresh/); assert.doesNotMatch(f.box.innerHTML, /stale/);
});
test("withdrawal removes loaded comparison text and fences pending reads", async () => {
  const f = fixture(); f.load(); f.respond(0, "sensitive previous"); await settle();
  assert.match(f.box.innerHTML, /sensitive previous/);
  f.state.messages.push({ id: "old-message", deletedAt: 1 }); f.controller.sync();
  assert.equal(f.box.innerHTML, ""); assert.match(f.box.textContent, /withdrawn/);
  f.load(); f.respond(1, "sensitive previous"); await settle(); assert.equal(f.box.innerHTML, "");
});
test("comparison escapes result text before rendering", async () => {
  const f = fixture(); f.load(); f.respond(0, "<img src=x>"); await settle();
  assert.doesNotMatch(f.box.innerHTML, /<img/); assert.match(f.box.innerHTML, /&lt;img/);
});

test("missing previous result explains unavailable comparison instead of silently hiding it", async () => {
  const f = fixture(); f.load(); f.pending[0](null); await settle();
  assert.equal(f.box.hidden, false); assert.match(f.box.innerHTML, /could not be loaded/);
});
test("a mismatched completion cannot display another version as the prior result", async () => {
  const f = fixture(); f.load();
  f.pending[0]({ result: { receipt: { eventId: "different" }, text: { body: "wrong version" } } });
  await settle(); assert.doesNotMatch(f.box.innerHTML, /wrong version/); assert.match(f.box.innerHTML, /could not be loaded/);
});
