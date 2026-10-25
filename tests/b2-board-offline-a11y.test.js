// QA7/QA8 batch B2. Each case is a behavior the board, sign-in, or
// conversation got wrong: accepted work shown as unclaimed, deploy drift in
// every room, a dropped room link, a first-run dialog with no keyboard
// contract, a connection label that ignored the browser, and message tab stops.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

if (typeof globalThis.document === "undefined") {
  globalThis.document = {
    documentElement: { dataset: {} },
    querySelector() { return null; },
    addEventListener() {},
    createElement() { return { setAttribute() {}, addEventListener() {} }; }
  };
}
import { boardHtml } from "../src/board-ui.js";
import { mountAgentFirstRun, FIRST_RUN_SEEN_KEY } from "../src/agent-first-run.js";
import { rememberRoomReturn, readRoomReturn, takeRoomReturn, signInToOpenLabel, ROOM_RETURN_KEY } from "../src/signin-entry.js";
import { createAgentSigninUI } from "../src/agent-signin-ui.js";

const app = await import("../src/app.js");
const { connectionView, composerNotices, presenceRefreshOn, slashFocusesSearch, applyMessageRoving, installSkipToComposer } = app;

const NOW = Date.parse("2026-10-24T12:00:00Z");
const VIEWER = { id: "viewer", manage: false, owner: false, write: true };

function memoryStore() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

test("accepted work with a processing session and no claim row is in progress under its holder", () => {
  const html = boardHtml([], null, VIEWER, {
    ada: { id: "ada", displayName: "Ada", kind: "human" }
  }, NOW, {
    canWrite: true,
    workItems: { work1: { id: "work1", title: "Write the notes", state: "accepted", accountableMemberId: "ada" } },
    sessions: [{ workItemId: "work1", status: "processing", worker_member_id: "ada", heartbeat_at: new Date(NOW).toISOString() }]
  });
  const claimed = html.split('id="board-col-claimed"')[1]?.split("</section>")[0] ?? "";
  const ready = html.split('id="board-col-ready"')[1]?.split("</section>")[0] ?? "";
  assert.match(claimed, /Write the notes/);
  assert.match(claimed, /Working: Ada/);
  assert.doesNotMatch(claimed, /data-claim-action="claim"/);
  assert.doesNotMatch(ready, /Write the notes/);
});

test("an accepted assignee with no session is named in progress and cannot be claimed again", () => {
  const html = boardHtml([], null, VIEWER, {
    ada: { id: "ada", displayName: "Ada", kind: "human" }
  }, NOW, {
    canWrite: true,
    workItems: { work1: { id: "work1", title: "Write the notes", state: "accepted", assignee: "ada" } }
  });
  const claimed = html.split('id="board-col-claimed"')[1]?.split("</section>")[0] ?? "";
  assert.match(claimed, /<span>Ada<\/span>/);
  assert.doesNotMatch(claimed, /Working:/);
  assert.doesNotMatch(claimed, /Unclaimed/);
  assert.doesNotMatch(claimed, /data-claim-action="claim"/);
});

test("a stale processing session does not count as someone working", () => {
  const html = boardHtml([], null, VIEWER, {}, NOW, {
    canWrite: true,
    workItems: { work1: { id: "work1", title: "Write the notes", state: "proposed" } },
    sessions: [{ workItemId: "work1", status: "processing", worker_member_id: "ada", heartbeat_at: new Date(NOW - 11 * 60 * 1000).toISOString() }]
  });
  assert.doesNotMatch(html, /Write the notes/);
});

test("deploy drift shows for the Project Room repo and for the operator, and stays hidden otherwise", () => {
  const hidden = boardHtml([], { behind: 0 }, VIEWER, {}, NOW, { room: { repo: "other/repo" } });
  assert.doesNotMatch(hidden, /class="live-chip"/);
  const byRepo = boardHtml([], { behind: 0 }, VIEWER, {}, NOW, { room: { repo: "Uuriko/project-room" } });
  assert.match(byRepo, /<p class="live-chip">Live matches main<\/p>/);
  const byUrl = boardHtml([], { behind: 0 }, VIEWER, {}, NOW, { room: { repository: "https://github.com/Uuriko/project-room.git" } });
  assert.match(byUrl, /class="live-chip"/);
  const byOperator = boardHtml([], { behind: 0 }, { ...VIEWER, operator: true }, {}, NOW, { room: { repo: "other/repo" } });
  assert.match(byOperator, /class="live-chip"/);
});

test("a logged-out #room link is remembered and named, then consumed once", () => {
  const store = memoryStore();
  assert.equal(rememberRoomReturn("#room/qa-west", store), "qa-west");
  assert.equal(store.getItem(ROOM_RETURN_KEY), "qa-west");
  assert.equal(readRoomReturn(store), "qa-west");
  assert.equal(signInToOpenLabel("qa-west"), "Sign in to open qa-west");
  assert.equal(rememberRoomReturn("#not-a-room", store), null);
  assert.equal(readRoomReturn(store), "qa-west");
  assert.equal(takeRoomReturn(store), "qa-west");
  assert.equal(readRoomReturn(store), null);
});

test("the agent room list auto-selects the remembered room", async t => {
  const store = memoryStore();
  rememberRoomReturn("#room/qa-west", store);
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: store });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: null } });
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: options?.body });
    if (String(url).endsWith("/api/auth/agent/rooms")) {
      return { ok: true, status: 200, json: async () => ({ displayName: "Ada", rooms: [{ roomId: "qa-west", title: "West" }, { roomId: "other", title: "Other" }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ roomId: "qa-west" }) };
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousStorage) Object.defineProperty(globalThis, "sessionStorage", previousStorage);
    else delete globalThis.sessionStorage;
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
  });
  const listeners = {};
  const container = {
    innerHTML: "", hidden: false, listeners,
    addEventListener(name, fn) { (listeners[name] ??= []).push(fn); },
    removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, contains() { return false; }
  };
  const started = [];
  createAgentSigninUI({ onSignedIn: session => { started.push(session.roomId); }, firstRunActions: {} }).mount(container);
  assert.match(container.innerHTML, /Sign in to open qa-west/);
  const form = { dataset: { agentForm: "credentials" }, values: { identityId: "ai_test", secret: "pri_test" }, closest: () => form };
  container.contains = node => node === form;
  const previousFormData = globalThis.FormData;
  globalThis.FormData = class { entries() { return Object.entries(form.values); } };
  try {
    await listeners.submit[0]({ target: form, preventDefault() {} });
  } finally {
    globalThis.FormData = previousFormData;
  }
  const sessionCall = calls.find(call => String(call.url).endsWith("/api/auth/agent/session"));
  assert.equal(JSON.parse(sessionCall.body).roomId, "qa-west");
  assert.deepEqual(started, ["qa-west"]);
});

function dialogDom(t) {
  const storage = new Map();
  const attrs = new Map();
  let active = null;
  function element(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      id: "",
      className: "",
      innerHTML: "",
      textContent: "",
      hidden: false,
      type: "",
      disabled: false,
      tabIndex: 0,
      dataset: {},
      href: "",
      target: "",
      rel: "",
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(name, value) {
        attrs.set(node, { ...(attrs.get(node) ?? {}), [name]: value });
        if (name === "data-step") node.dataset.step = value;
      },
      getAttribute(name) { return attrs.get(node)?.[name] ?? null; },
      appendChild(child) { node.children.push(child); return child; },
      append(...kids) { for (const kid of kids) if (typeof kid !== "string") node.children.push(kid); },
      addEventListener(type, fn) { (node.handlers ??= {})[type] = fn; },
      remove() { node.removed = true; if (active === node) active = null; },
      focus() { active = node; },
      contains(other) { return node === other || node.children.some(child => child === other || child.contains?.(other)); },
      querySelectorAll() {
        const buttons = [];
        const markup = node.innerHTML ?? "";
        for (const match of markup.matchAll(/<button\b[^>]*data-step="([^"]+)"[^>]*>/g)) {
          buttons.push({ dataset: { step: match[1] }, focus() { active = this; }, tabIndex: 0, disabled: false, hidden: false });
        }
        for (const child of node.children) {
          if (child.tagName === "BUTTON") buttons.push(child);
          else if (child.querySelectorAll) buttons.push(...child.querySelectorAll("button"));
        }
        return buttons;
      }
    };
    return node;
  }
  const body = element("body");
  const previous = new Map(["document", "localStorage", "MutationObserver"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const document = {
    body,
    activeElement: null,
    createElement: element,
    querySelector(selector) { return selector === "#main" ? document.main ?? null : null; }
  };
  Object.defineProperty(document, "activeElement", { get: () => active, set(value) { active = value; } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  } });
  return { document, body, attrs, storage, element };
}

test("first-run is a dialog, Escape closes it, and focus moves inside", t => {
  const { body, attrs } = dialogDom(t);
  const before = { focus() { globalThis.document.activeElement = before; }, dataset: {} };
  globalThis.document.activeElement = before;
  const card = mountAgentFirstRun({ container: body, actions: {} });
  assert.equal(card.getAttribute("role"), "dialog");
  assert.equal(card.getAttribute("aria-modal"), "true");
  assert.equal(card.getAttribute("aria-labelledby"), "agent-first-run-title");
  assert.match(card.innerHTML, /id="agent-first-run-title"/);
  assert.doesNotMatch(card.innerHTML, /🪔/);
  assert.match(card.innerHTML, /if anyone is noisy, block or mute them/);
  assert.notEqual(globalThis.document.activeElement, before);
  card.handlers.keydown({ key: "Escape", preventDefault() {} });
  assert.equal(card.removed, true);
  assert.equal(globalThis.localStorage.getItem(FIRST_RUN_SEEN_KEY), "1");
  assert.equal(globalThis.document.activeElement, before);
  assert.ok(attrs);
});

test("first-run waits until the room view is visible", t => {
  const { document, element } = dialogDom(t);
  const main = element("main");
  main.hidden = true;
  document.main = main;
  let observed = null;
  Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: class {
    constructor(callback) { this.callback = callback; observed = this; }
    observe() {}
    disconnect() { this.disconnected = true; }
  } });
  assert.equal(mountAgentFirstRun({ actions: {}, whenRoomMounted: true }), null);
  assert.equal(main.children.includes(undefined) || main.children.length, 0);
  main.hidden = false;
  observed.callback();
  assert.equal(main.children.length, 1);
  assert.equal(main.children[0].getAttribute("role"), "dialog");
  assert.equal(observed.disconnected, true);
});

test("connection label follows the browser and the stream", () => {
  const connected = "Connected to room service · no peer read or processing receipt";
  assert.deepEqual(connectionView({ online: true, streamText: connected }), { visible: "Connected", explanation: connected, state: "connected", interrupted: false });
  assert.equal(connectionView({ online: false, streamText: connected }).visible, "Offline");
  assert.equal(connectionView({ online: true, streamText: "Reconnecting · displayed history may be stale" }).visible, "Reconnecting");
  assert.equal(connectionView({ online: true, streamText: "Connection interrupted · refresh to recover" }).visible, "Reconnecting");
});

test("a new send clears the saved note and success clears the interruption", () => {
  assert.deepEqual(composerNotices({ delivery: "Message saved. ", interruption: "Could not send." }, "send-start"), { delivery: "", interruption: "Could not send." });
  assert.deepEqual(composerNotices({ delivery: "", interruption: "Could not send." }, "send-success", { delivery: "Message saved. " }), { delivery: "Message saved. ", interruption: "" });
});

test("presence refresh retries when the browser or the stream comes back", () => {
  assert.equal(presenceRefreshOn({ event: "online" }), true);
  assert.equal(presenceRefreshOn({ event: "stream-connected", hadDrop: false }), false);
  assert.equal(presenceRefreshOn({ event: "stream-connected", hadDrop: true }), true);
  assert.equal(presenceRefreshOn({ event: "tick" }), false);
});

test("slash focuses search only outside fields and dialogs", () => {
  const event = { key: "/" };
  assert.equal(slashFocusesSearch(event), true);
  assert.equal(slashFocusesSearch(event, { inField: true }), false);
  assert.equal(slashFocusesSearch(event, { dialogOpen: true }), false);
  assert.equal(slashFocusesSearch({ ...event, altKey: true }), false);
});

test("messages expose one tab stop and a skip-to-composer link", () => {
  function control() {
    return { control: true, tabIndex: 0 };
  }
  function row() {
    const children = [control(), control()];
    return {
      className: "message",
      tabIndex: -1,
      children,
      contains() { return false; },
      querySelectorAll(selector) {
        return selector.includes("button") ? children : [];
      }
    };
  }
  const rows = [row(), row(), row()];
  const list = {
    tabIndex: 0,
    querySelectorAll(selector) { return selector.includes(".message") ? rows : []; }
  };
  applyMessageRoving(list);
  assert.equal(list.tabIndex, -1);
  assert.equal(rows.filter(item => item.tabIndex === 0).length, 1);
  assert.equal(rows[0].tabIndex, 0);
  assert.deepEqual(rows.flatMap(item => item.children.map(child => child.tabIndex)), [-1, -1, -1, -1, -1, -1]);
  const created = [];
  const doc = {
    querySelector(selector) { return selector === "#skip-link" ? doc.skip : selector === "#message-input" ? doc.input : null; },
    createElement() {
      const node = { attributes: {}, setAttribute(name, value) { node.attributes[name] = value; }, addEventListener() {} };
      created.push(node);
      return node;
    },
    skip: { insertAdjacentElement(_where, node) { doc.link = node; } },
    input: { setAttribute(name, value) { this.attributes = { ...(this.attributes ?? {}), [name]: value }; }, attributes: {} }
  };
  const link = installSkipToComposer(doc);
  assert.equal(link.textContent, "Skip to composer");
  assert.equal(link.getAttribute ? link.attributes["aria-keyshortcuts"] : link.attributes["aria-keyshortcuts"], "Alt+Shift+C");
  assert.equal(link.href, "#message-input");
  assert.equal(doc.input.attributes["aria-keyshortcuts"], "Alt+Shift+C");
});

test("message text clips combining marks and timestamps are at least 24px", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const body = css.match(/\.message-content > \.message-body \{[^}]+\}/)?.[0] ?? "";
  assert.match(body, /overflow:\s*clip/);
  assert.match(body, /overflow-clip-margin:\s*0\.15em/);
  const time = css.match(/\.message-time \{[^}]+\}/)?.[0] ?? "";
  assert.match(time, /min-height:\s*24px/);
  assert.match(time, /padding-block:/);
});
