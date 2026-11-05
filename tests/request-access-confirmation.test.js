import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sanitizeHtml from "sanitize-html";
import { AccountClient } from "../src/client.js";

// Execute the real submit listener (src/join.js's request-access door)
// against ancestry parsed from join.html. The browser suite owns CSS
// visibility, request transport, and retry behavior.
//
// The door's home is the join page since the #3293 consolidation; this
// suite began against the account-panel door in index.html and follows
// the door. Its guard is the same: after a successful submit the form
// hides — the confirmation must not hide with it. (The join page's first
// cut of the door placed the status inside the form, recreating exactly
// this failure; the status now sits outside the form, as the account
// door's did.)
for (const delayedResume of [false, true]) test(`request confirmation stays visible; delayed resume=${delayedResume}`, async t => {
  const nodes = new Map(), stack = [];
  sanitizeHtml(readFileSync(new URL("../join.html", import.meta.url), "utf8"), {
    onOpenTag(tag, attrs) {
      const classes = new Set((attrs.class ?? "").split(/\s+/));
      const node = Object.assign(new EventTarget(), {
        tag, attrs, parent: stack.at(-1), hidden: "hidden" in attrs,
        open: "open" in attrs, value: attrs.value ?? "", textContent: "",
        disabled: false, dataset: {},
        classes, classList: {
          add(...names) { for (const name of names) classes.add(name); },
          remove(...names) { for (const name of names) classes.delete(name); },
          toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
          contains(name) { return classes.has(name); },
        },
        focus() {},
        addEventListener(type, listener) {
          EventTarget.prototype.addEventListener.call(this, type, event => { this.submission = listener(event); });
        },
      });
      if (attrs.id) nodes.set(attrs.id, node);
      stack.push(node);
    },
    onCloseTag() { stack.pop(); },
  });
  const get = id => { assert.ok(nodes.has(id), `Missing #${id}`); return nodes.get(id); };
  const values = new Map();
  const strict = value => new Proxy(value, {
    get(target, key) { assert.ok(key in target, `Unexpected API: ${String(key)}`); return target[key]; },
  });
  const storage = strict({
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  });
  const previous = {
    document: globalThis.document, window: globalThis.window,
    location: globalThis.location, sessionStorage: globalThis.sessionStorage,
    addEventListener: globalThis.addEventListener, removeEventListener: globalThis.removeEventListener,
  };
  let activeWatches = 0;
  globalThis.document = strict({
    getElementById: id => nodes.get(id) ?? null,
    readyState: "complete", hidden: true,
    removeEventListener: type => { if (type === "visibilitychange") activeWatches--; },
    addEventListener: type => { if (type === "visibilitychange") activeWatches++; },
    createElement: tag => ({ tag, children: [], textContent: "", appendChild() {} }),
  });
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.window = strict({ sessionStorage: storage });
  globalThis.sessionStorage = storage;
  globalThis.location = { pathname: "/join", search: delayedResume ? "?room=old-room&access-request=pending" : "", origin: "http://localhost", assign: () => {} };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network call"); });
  t.mock.method(AccountClient.prototype, "mintAccessIdentity", async () => ({ identityId: "ai_confirmation_fixture" }));
  let releaseResume, restores = 0;
  const human = { authenticated: true, account: {id:"human-confirmation"} };
  const delayed = new Promise(resolve => { releaseResume = resolve; });
  t.mock.method(AccountClient.prototype, "restore", async () => delayedResume && restores++ === 0 ? delayed : human);
  values.set('pr:human-access-request:["human-confirmation","old-room"]', JSON.stringify({authEpoch:0, requestId:"ar_old",payload:{roomId:"old-room",requestId:"ar_old"}}));
  let submitted;
  t.mock.method(AccountClient.prototype, "submitAccountAccessRequest", async body => { submitted = body; return { request: {...body,principalKind:"account",status:"pending"} }; });
  await import(`../src/join.js?confirmation=${delayedResume}`);
  if (delayedResume) assert.equal(get("join-request-submit").disabled, true, "resume disables submission while restoring");
  const form = get("join-request-form"), status = get("join-request-status");
  assert.equal(form.dataset.requestWired, "1", "the door's submit listener is wired");
  get("join-request").open = true;
  // The visitor is on the bare entry page and fills the request door
  // (after boot, as a person would — boot prefills the room field).
  get("join-request-room").value = "commons";
  get("join-request-name").value = "Confirmation applicant";
  assert.equal(form.dispatchEvent(new Event("submit", { cancelable: true })), false);
  await form.submission;
  const newerConfirmation = status.textContent;
  releaseResume(human);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(status.textContent, newerConfirmation, "late old resume cannot replace new intent");
  assert.equal(activeWatches, 1, "only the newest admission may keep a watcher");
  assert.ok(submitted, "the actual handler submitted the request");
  assert.equal(submitted.roomId, "commons");
  assert.equal(form.hidden, true);
  assert.ok(status.textContent.includes(submitted.roomId));
  assert.ok(status.textContent.includes(submitted.requestId));
  assert.equal(status.attrs.role, "status");
  assert.equal(status.classes.has("visible"), true);
  for (let node = status; node; node = node.parent) {
    assert.equal(node.hidden, false, `Confirmation is concealed by #${node.attrs.id ?? node.tag}`);
    if (node.tag === "details") assert.equal(node.open, true);
  }
});
