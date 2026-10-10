import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sanitizeHtml from "sanitize-html";
import { AccountClient } from "../src/client.js";

// Execute the real submit listener against ancestry parsed from index.html.
// The browser suite owns CSS visibility, request transport, and retry behavior.
test("request confirmation has no hidden ancestor after the form submits", async t => {
  const nodes = new Map(), stack = [];
  sanitizeHtml(readFileSync(new URL("../index.html", import.meta.url), "utf8"), {
    onOpenTag(tag, attrs) {
      const classes = new Set((attrs.class ?? "").split(/\s+/));
      const node = Object.assign(new EventTarget(), {
        tag, attrs, parent: stack.at(-1), hidden: "hidden" in attrs,
        open: "open" in attrs, value: attrs.value ?? "", textContent: "",
        classes, classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name); } },
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
  // The user is on Rooms and has opened the request disclosure.
  get("account-rooms-panel").hidden = false;
  get("account-request-access").open = true;
  get("account-request-room").value = "commons";
  get("account-request-name").value = "Confirmation applicant";
  const values = new Map();
  const strict = value => new Proxy(value, {
    get(target, key) { assert.ok(key in target, `Unexpected API: ${String(key)}`); return target[key]; },
  });
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = strict({ getElementById: id => nodes.get(id) ?? null });
  globalThis.window = strict({ sessionStorage: strict({
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  }) });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network call"); });
  t.mock.method(AccountClient.prototype, "mintAccessIdentity", async () => ({ identityId: "ai_confirmation_fixture" }));
  let submitted;
  t.mock.method(AccountClient.prototype, "submitAccessRequest", async body => { submitted = body; return { ok: true }; });
  await import("../src/request-access.js");
  const form = get("account-request-form"), status = get("account-request-status");
  assert.equal(form.dispatchEvent(new Event("submit", { cancelable: true })), false);
  await form.submission;
  assert.ok(submitted, "the actual handler submitted the request");
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
