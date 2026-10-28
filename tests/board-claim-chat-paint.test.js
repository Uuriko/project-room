// paintClaimChat runs on every chat render. It used to look up each rendered
// message's time with state.messages.find(), which is quadratic in room size
// (about 12.5M comparisons per render at 5,000 messages). These tests pin the
// placement contract and that one paint reads the message list a bounded
// number of times. Minimal DOM stand-ins; no browser.
import test from "node:test";
import assert from "node:assert/strict";
import { paintClaimChat } from "../src/board-ui.js";

function fakeDom(messageIds) {
  const children = messageIds.map(id => ({ kind: "message", dataset: { messageRecordId: id }, remove() { children.splice(children.indexOf(this), 1); } }));
  const list = {
    children,
    querySelectorAll(selector) {
      if (selector === "[data-claim-update]") return children.filter(node => node.dataset.claimUpdate);
      if (selector === ":scope > .message") return children.filter(node => node.kind === "message");
      throw new Error("unexpected selector " + selector);
    },
    insertBefore(node, before) {
      node.remove = () => children.splice(children.indexOf(node), 1);
      if (before) children.splice(children.indexOf(before), 0, node); else children.push(node);
    }
  };
  return list;
}

function withDocument(t) {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ dataset: {}, className: "", textContent: "" }) };
  t.after(() => { globalThis.document = previous; });
}

const iso = minute => new Date(Date.UTC(2026, 9, 9, 0, minute)).toISOString();
const claimEvent = (id, minute) => ({ id, type: "work_claim.updated", at: iso(minute), actorId: "fo", data: { workClaim: id, action: "claimed", title: id } });

test("a claim update lands before the first message posted after it, and repaints replace it", t => {
  withDocument(t);
  const messages = [0, 10, 20, 30].map(minute => ({ id: `m${minute}`, createdAt: iso(minute) }));
  const state = { messages, members: { fo: { displayName: "Fo" } }, eventLog: [claimEvent("card-a", 15)] };
  const list = fakeDom(messages.map(message => message.id));
  paintClaimChat(state, list);
  paintClaimChat(state, list);
  const order = list.children.map(node => node.dataset.messageRecordId ?? `claim:${node.dataset.claimUpdate}`);
  assert.deepEqual(order, ["m0", "m10", "claim:card-a", "m20", "m30"]);
});

test("one paint reads the message list a bounded number of times, not once per rendered message", t => {
  withDocument(t);
  const count = 400, plain = Array.from({ length: count }, (_, i) => ({ id: `m${i}`, createdAt: iso(i) }));
  let reads = 0;
  const messages = new Proxy(plain, { get(target, key, receiver) { if (typeof key === "string" && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
  const state = { messages, members: {}, eventLog: [claimEvent("card-b", count + 5)] };
  paintClaimChat(state, fakeDom(plain.map(message => message.id)));
  assert.ok(reads <= 2 * count, `read ${reads} message slots for ${count} messages`);
});
