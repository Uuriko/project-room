import test from "node:test";
import assert from "node:assert/strict";
import { createResultComparison } from "../src/result-comparison.js";

function fixture() {
  const pending = [], state = { messages: [] };
  const box = {
    hidden: true,
    ownerDocument: { createElement: () => ({
      innerHTML: "", textContent: "",
      insertAdjacentHTML(_position, html) { this.innerHTML = html + this.innerHTML; },
    }) },
    content: null,
    message: "",
    get innerHTML() { return this.content?.textContent ? "" : this.content?.innerHTML ?? ""; },
    get textContent() { return this.content?.textContent || this.message; },
    set textContent(text) { this.content = null; this.message = text; },
    append(content) { this.content = content; },
    replaceChildren() { this.content = null; this.message = ""; },
    querySelector(selector) {
      if (selector !== "[data-previous-release-checks]" || !this.content) return null;
      return { remove: () => {
        this.content.innerHTML = this.content.innerHTML.replace(/^<p data-previous-release-checks.*?<\/p>/, "");
      } };
    },
  };
  const controller = createResultComparison({ getState: () => state,
    client: { workResult: () => new Promise(resolve => pending.push(resolve)) },
    esc: text => String(text).replaceAll("<", "&lt;").replaceAll(">", "&gt;") });
  const respond = (index, body = "old") => pending[index]({ result: { receipt: { eventId: "previous" }, text: { messageId: "old-message", body } } });
  const load = (body = "new") => controller.load("work", "previous", { messageId: "current", body }, box, () => true);
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

test("prior release links require the pinned evidence and a selected Room message", async () => {
  const f = fixture();
  const previous = { result: {receipt:{eventId:"previous", evidenceVersion:"v1"}, text:{body:"old", messageId:"old-message"}},
    workThread: { releaseChecks: {completionEventId:"previous", evidenceVersion:"v1", candidateRevision:"a".repeat(40),
      checks:[{stage:"build", evidenceMessageId:"receipt", href:"#pr-record/message/receipt"},
        {stage:"deploy", evidenceMessageId:"another", href:"https://example.org"}]}} };
  f.load(); f.pending[0](previous); await settle();
  assert.match(f.box.innerHTML, /Previous release checks \(aaaaaaaaaaaa\)/);
  assert.match(f.box.innerHTML, /#pr-record\/message\/receipt/);
  assert.doesNotMatch(f.box.innerHTML, /example.org|>Deploy</);
  f.state.messages.push({id:"receipt", editedAt:1}); f.controller.sync();
  assert.doesNotMatch(f.box.innerHTML, /Previous release checks/);
  assert.match(f.box.innerHTML, /Resubmitted result/);
  previous.workThread.releaseChecks.evidenceVersion = "other";
  f.state.messages.length = 0;
  f.load(); f.pending[1](previous); await settle();
  assert.doesNotMatch(f.box.innerHTML, /Previous release checks/);
  delete previous.result.receipt.evidenceVersion;
  delete previous.workThread.releaseChecks.evidenceVersion;
  f.load(); f.pending[2](previous); await settle();
  assert.doesNotMatch(f.box.innerHTML, /Previous release checks/);
  assert.match(f.box.innerHTML, /Resubmitted result/);
});

test("long results show the late correction with local context", async () => {
  const f = fixture(), lines = Array.from({ length: 520 }, (_, i) => "Section " + i);
  const before = lines.join("\n");
  lines[511] = "Updated review decision";
  f.load(lines.join("\n")); f.respond(0, before); await settle();
  assert.match(f.box.innerHTML, /1 lines removed, 1 added/);
  assert.match(f.box.innerHTML, /- Section 511/);
  assert.match(f.box.innerHTML, /\+ Updated review decision/);
  assert.match(f.box.innerHTML, /Section 510/);
  assert.doesNotMatch(f.box.innerHTML, /Section 100|more patch rows/);
});

test("newline-only edits remain visible and a large rewrite stays bounded", async () => {
  const f = fixture();
  f.load("final line\n"); f.respond(0, "final line"); await settle();
  assert.match(f.box.innerHTML, /Final line break added/);
  assert.match(f.box.innerHTML, /Previous approval never carries over/);
  assert.doesNotMatch(f.box.innerHTML, /diff-(removed|added)|No text changes/);
  f.load("a\n\nend"); f.respond(1, "a\nend"); await settle();
  assert.match(f.box.innerHTML, /0 lines removed, 1 added/);
  f.load("new\n".repeat(600)); f.respond(2, "old\n".repeat(600)); await settle();
  assert.match(f.box.innerHTML, /Too many changed lines/);
});

test("exact prose comparisons explain a changed file ending once", async () => {
  const f = fixture();
  f.load("New proposal"); f.respond(0, "Old proposal"); await settle();
  assert.match(f.box.innerHTML, /- Old proposal/);
  assert.match(f.box.innerHTML, /\+ New proposal/);
  assert.doesNotMatch(f.box.innerHTML, /No newline at end of file|Final line break/);

  f.load("New proposal\nClosing line"); f.respond(1, "Old proposal\nClosing line\n"); await settle();
  assert.equal(f.box.innerHTML.match(/Final line break removed/g)?.length, 1);
  assert.match(f.box.innerHTML, /1 lines removed, 1 added/);
  assert.doesNotMatch(f.box.innerHTML, /[+-] Closing line|No newline at end of file/);

  f.load("One line\r\n"); f.respond(2, "One line"); await settle();
  assert.match(f.box.innerHTML, /Final line break added/);
  assert.doesNotMatch(f.box.innerHTML, /diff-(removed|added)/);

  f.load("One line\n\n"); f.respond(3, "One line\n"); await settle();
  assert.match(f.box.innerHTML, /0 lines removed, 1 added/);
  assert.doesNotMatch(f.box.innerHTML, /Final line break/);
});
