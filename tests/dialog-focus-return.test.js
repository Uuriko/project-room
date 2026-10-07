// Lane D3 (accessibility): modal dialogs return focus to the invoking control
// when they close.
//
// A native <dialog> does not restore focus on close: without an explicit
// restore, keyboard and screen-reader users land on <body> and lose their
// place (WCAG 2.4.3 focus order). Each test below opens a real module dialog
// through its public install/mount entry point under a stub document, closes
// it the way a user would (Escape -> close event, or the dialog's own close
// control -> dialog.close()), and asserts the invoking control regains focus.
//
// Fail-first: before the fix, focus stays wherever the dialog left it
// (usually <body>) instead of returning to the trigger.
import test from "node:test";
import assert from "node:assert/strict";
import { installAgentInvites } from "../src/agent-invite-ui.js";
import { installAgentConnections } from "../src/agent-connections.js";
import { installGmailWorkspace } from "../src/gmail-ui.js";
import { installHumanExperience } from "../src/human-experience.js";
import { createAccountSettingsUI } from "../src/account-settings-ui.js";
import { mountUpdates } from "../src/updates-ui.js";

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

// Minimal stub document: real element tree, a small selector engine
// (#id, .class, [attr], [attr="v"], tag, tag[attr="v"], comma lists),
// a lenient innerHTML parser for the modules' static templates, and
// focus/showModal/close semantics. innerHTML is parsed into real stub
// children (unlike a write-only stub) so dialog.querySelector lookups the
// modules perform after setting innerHTML keep working.
function installDom(t) {
  const byId = new Map();

  function descendants(el, out = []) {
    for (const child of el.children ?? []) {
      out.push(child);
      descendants(child, out);
    }
    return out;
  }

  function matchSimple(el, sel) {
    if (!el.tagName) return false;
    let rest = sel.trim();
    const tagMatch = rest.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
    if (tagMatch) {
      if (el.tagName !== tagMatch[0].toUpperCase()) return false;
      rest = rest.slice(tagMatch[0].length);
    }
    while (rest.length) {
      if (rest[0] === "#") {
        const m = rest.match(/^#([^\s.#[\]]+)/);
        if (!m || el.id !== m[1]) return false;
        rest = rest.slice(m[0].length);
      } else if (rest[0] === ".") {
        const m = rest.match(/^\.([^\s.#[\]]+)/);
        if (!m || !el.classList.contains(m[1])) return false;
        rest = rest.slice(m[0].length);
      } else if (rest[0] === "[") {
        const m = rest.match(/^\[([^\]=\s]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\]/);
        if (!m) return false;
        const actual = el.getAttribute(m[1]);
        if (actual === null) return false;
        const want = m[2] ?? m[3] ?? m[4];
        if (want !== undefined && actual !== want) return false;
        rest = rest.slice(m[0].length);
      } else {
        return false;
      }
    }
    return true;
  }

  function queryAllFrom(root, selector) {
    const out = [];
    for (const part of String(selector).split(",")) {
      const sel = part.trim();
      if (!sel) continue;
      for (const el of [root, ...descendants(root)]) {
        if (matchSimple(el, sel) && !out.includes(el)) out.push(el);
      }
    }
    return out;
  }

  function makeTextNode(text) {
    const tn = {
      nodeType: 3, tagName: "", textContent: String(text), parent: null, children: [],
      remove() {
        if (tn.parent) {
          tn.parent.children = tn.parent.children.filter(c => c !== tn);
          tn.parent = null;
        }
      },
    };
    return tn;
  }

  function makeEl(tag) {
    const children = [];
    const handlers = {};
    const attrs = {};
    const classSet = new Set();
    const el = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      parent: null,
      children,
      handlers,
      style: {},
      tabIndex: 0,
      textContent: "",
      hidden: false,
      disabled: false,
      open: false,
      value: "",
      checked: false,
      focused: false,
      scrollTop: 0,
      onclick: null,
      onsubmit: null,
      get isConnected() {
        let node = el.parent;
        while (node) {
          if (node === body) return true;
          node = node.parent;
        }
        return false;
      },
      setAttribute(name, value) {
        const key = String(name).toLowerCase();
        const val = String(value);
        if (key === "id") { el.id = val; return; }
        if (key === "class") { el.className = val; return; }
        attrs[key] = val;
        if (key.startsWith("data-")) {
          dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val;
        }
      },
      getAttribute(name) {
        const v = attrs[String(name).toLowerCase()];
        return v === undefined ? null : v;
      },
      hasAttribute(name) { return String(name).toLowerCase() in attrs; },
      removeAttribute(name) {
        const key = String(name).toLowerCase();
        if (key === "id") { el.id = ""; return; }
        delete attrs[key];
        if (key.startsWith("data-")) delete dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
      },
      append(...kids) {
        for (const kid of kids.flat(Infinity)) {
          if (kid == null || typeof kid === "string") continue;
          if (typeof kid.remove === "function") kid.remove();
          kid.parent = el;
          children.push(kid);
          if (kid.id) byId.set(kid.id, kid);
        }
        return el;
      },
      appendChild(kid) { el.append(kid); return kid; },
      prepend(...kids) {
        const flat = kids.flat(Infinity).filter(k => k != null && typeof k !== "string");
        for (const kid of flat) if (typeof kid.remove === "function") kid.remove();
        for (let i = flat.length - 1; i >= 0; i--) {
          flat[i].parent = el;
          children.unshift(flat[i]);
          if (flat[i].id) byId.set(flat[i].id, flat[i]);
        }
        return el;
      },
      before(...nodes) {
        if (!el.parent) return;
        const idx = el.parent.children.indexOf(el);
        const flat = nodes.flat(Infinity).filter(n => n != null && typeof n !== "string");
        for (const n of flat) if (typeof n.remove === "function") n.remove();
        flat.forEach(n => { n.parent = el.parent; if (n.id) byId.set(n.id, n); });
        el.parent.children.splice(idx, 0, ...flat);
      },
      replaceChildren(...kids) {
        for (const c of [...children]) if (typeof c.remove === "function") c.remove();
        el.append(...kids);
      },
      remove() {
        if (el.parent) {
          el.parent.children = el.parent.children.filter(c => c !== el);
          el.parent = null;
        }
        if (el.id) byId.delete(el.id);
      },
      addEventListener(type, fn, options) {
        (handlers[type] ??= []).push({ fn, once: Boolean(options && options.once) });
      },
      removeEventListener(type, fn) {
        handlers[type] = (handlers[type] ?? []).filter(h => h.fn !== fn);
      },
      querySelector(sel) { return queryAllFrom(el, sel)[0] ?? null; },
      querySelectorAll(sel) { return queryAllFrom(el, sel); },
      closest(sel) {
        let node = el;
        while (node && node.tagName) {
          if (matchSimple(node, sel)) return node;
          node = node.parent;
        }
        return null;
      },
      contains(node) { return node === el || descendants(el).includes(node); },
      getClientRects() { return [{}]; },
      getBoundingClientRect() { return {}; },
      scrollIntoView() {},
      focus() { el.focused = true; activeElement = el; },
      blur() { if (activeElement === el) activeElement = body; },
      click() { fire(el, "click", { target: el }); },
      // Like a real browser, opening a modal dialog moves focus into it
      // (first focusable element, else the dialog itself); the test then
      // asserts the module returns focus to the trigger on close.
      showModal() { el.open = true; el.focused = true; activeElement = el; },
      close() {
        if (!el.open) return;
        el.open = false;
        fire(el, "close", { target: el });
      },
      reset() {},
    };
    // dataset <-> data-* attributes stay in sync both ways.
    const dataset = new Proxy({}, {
      set(target, prop, value) {
        target[prop] = String(value);
        attrs["data-" + String(prop).replace(/[A-Z]/g, c => "-" + c.toLowerCase())] = String(value);
        return true;
      },
      get(target, prop) { return target[prop]; },
      deleteProperty(target, prop) {
        delete target[prop];
        delete attrs["data-" + String(prop).replace(/[A-Z]/g, c => "-" + c.toLowerCase())];
        return true;
      },
    });
    Object.defineProperty(el, "dataset", { value: dataset });
    let idVal = "";
    Object.defineProperty(el, "id", {
      get: () => idVal,
      set: v => {
        if (idVal) byId.delete(idVal);
        idVal = String(v ?? "");
        if (idVal) { attrs.id = idVal; byId.set(idVal, el); }
        else delete attrs.id;
      },
    });
    Object.defineProperty(el, "className", {
      get: () => [...classSet].join(" "),
      set: v => {
        classSet.clear();
        String(v ?? "").split(/\s+/).filter(Boolean).forEach(n => classSet.add(n));
        if (classSet.size) attrs.class = [...classSet].join(" ");
        else delete attrs.class;
      },
    });
    Object.defineProperty(el, "classList", {
      value: {
        add: (...names) => { names.forEach(n => classSet.add(n)); el.className = [...classSet].join(" "); },
        remove: (...names) => { names.forEach(n => classSet.delete(n)); el.className = [...classSet].join(" "); },
        toggle: (name, force) => {
          const next = force === undefined ? !classSet.has(name) : Boolean(force);
          if (next) classSet.add(name); else classSet.delete(name);
          el.className = [...classSet].join(" ");
          return next;
        },
        contains: name => classSet.has(name),
      },
    });
    let html = "";
    Object.defineProperty(el, "innerHTML", {
      get: () => html,
      set: v => { html = String(v ?? ""); parseInto(el, html); },
    });
    Object.defineProperty(el, "innerText", { get: () => el.textContent });
    Object.defineProperty(el, "elements", {
      get: () => {
        const out = {};
        for (const d of descendants(el)) {
          const name = d.getAttribute ? d.getAttribute("name") : null;
          if (name && !(name in out)) out[name] = d;
        }
        return out;
      },
    });
    return el;
  }

  function parseInto(parent, html) {
    for (const child of [...parent.children]) child.remove();
    const stack = [parent];
    const tokenRe = /<!--[\s\S]*?-->|<\/?[a-zA-Z!][^<>]*>|[^<]+/g;
    let token;
    while ((token = tokenRe.exec(html)) !== null) {
      const text = token[0];
      if (text.startsWith("<!--") || text.startsWith("<!")) continue;
      if (text.startsWith("</")) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      if (text[0] === "<") {
        const selfClosing = text.endsWith("/>");
        const inner = text.slice(1, selfClosing ? -2 : -1).trim();
        const space = inner.search(/[\s/]/);
        const tag = (space === -1 ? inner : inner.slice(0, space)).toLowerCase();
        const el = makeEl(tag);
        const attrString = (space === -1 ? "" : inner.slice(space)).replace(/\/$/, "");
        const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
        let attr;
        while ((attr = attrRe.exec(attrString)) !== null) {
          el.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? "");
        }
        stack[stack.length - 1].append(el);
        if (!selfClosing && !VOID_ELEMENTS.has(tag)) stack.push(el);
      } else if (text.trim()) {
        stack[stack.length - 1].append(makeTextNode(text));
      }
    }
  }

  function fire(el, type, event = {}) {
    const evt = {
      type, target: el, currentTarget: el,
      preventDefault() {}, stopPropagation() {},
      ...event,
    };
    for (const h of [...(el.handlers[type] ?? [])]) {
      h.fn.call(el, evt);
      if (h.once) el.removeEventListener(type, h.fn);
    }
    if (type === "click" && typeof el.onclick === "function") el.onclick.call(el, evt);
    if (type === "submit" && typeof el.onsubmit === "function") el.onsubmit.call(el, evt);
  }

  const body = makeEl("body");
  let activeElement = body;
  const document = {
    createElement: tag => makeEl(tag),
    createTextNode: text => makeTextNode(text),
    querySelector(sel) {
      const s = String(sel).trim();
      if (/^#[^\s.#[\],]+$/.test(s)) {
        const found = byId.get(s.slice(1));
        if (found && found.isConnected) return found;
      }
      return queryAllFrom(body, s)[0] ?? null;
    },
    querySelectorAll: sel => queryAllFrom(body, sel),
    getElementById(id) {
      const found = byId.get(id);
      return found && found.isConnected ? found : null;
    },
    body,
    hidden: false,
    title: "",
    addEventListener() {},
    removeEventListener() {},
    execCommand() { return false; },
  };
  Object.defineProperty(document, "activeElement", {
    get: () => activeElement ?? body,
    set: v => { activeElement = v; },
    configurable: true,
  });

  const previous = new Map();
  const globals = {
    document,
    setInterval: () => 0,
    clearInterval: () => {},
    confirm: () => true,
  };
  for (const key of Object.keys(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: globals[key] });
  }
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });

  return { document, body, fire, makeEl };
}

// ---------------------------------------------------------------------------
// src/agent-invite-ui.js — the agent-invite dialog
// ---------------------------------------------------------------------------

function inviteDom(dom) {
  const { document } = dom;
  const els = {};
  const kinds = { dialog: "dialog", form: "form" };
  for (const id of [
    "agent-invite-dialog", "agent-invite-form", "agent-invite-result", "invite-agents-button",
    "agent-invite-close", "agent-invite-copy", "agent-invite-copy-all", "agent-invite-another",
    "agent-invite-profile", "agent-invite-status", "agent-invite-count", "agent-invite-link",
    "agent-invite-single", "agent-invite-bulk",
  ]) {
    const tag = id === "agent-invite-dialog" ? "dialog" : id === "agent-invite-form" ? "form" : "button";
    const el = document.createElement(tag);
    el.id = id;
    document.body.append(el);
    els[id] = el;
  }
  return els;
}

test("agent-invite dialog returns focus to the invite button when closed", t => {
  const dom = installDom(t);
  const { document, fire } = dom;
  const els = inviteDom(dom);
  const session = { member: { id: "m1" }, roomId: "r1" };
  const state = { room: { id: "r1", ownerId: "m1" }, members: { m1: { id: "m1" } } };
  installAgentInvites({ client: { generation: 7 }, getState: () => state, getSession: () => session });

  const button = els["invite-agents-button"];
  const dialog = els["agent-invite-dialog"];
  document.activeElement = button; // keyboard focus sits on the invoking control
  fire(button, "click");
  assert.equal(dialog.open, true, "dialog opens on click");
  assert.equal(document.activeElement, els["agent-invite-profile"], "opening moves focus into the dialog");
  fire(els["agent-invite-close"], "click"); // the dialog's own close control
  assert.equal(dialog.open, false, "dialog closes");
  assert.equal(document.activeElement, button, "focus returns to the invoking button");
});

// ---------------------------------------------------------------------------
// src/agent-connections.js — the connect-agent dialog
// ---------------------------------------------------------------------------

test("connect-agent dialog returns focus to its opener when closed", t => {
  const dom = installDom(t);
  const { document, fire } = dom;
  const els = {};
  for (const id of [
    "agent-access-hint", "agent-capabilities", "agent-connect-access", "agent-connect-advanced",
    "agent-connect-close", "agent-connect-dialog", "agent-connect-done", "agent-connect-expiry",
    "agent-connect-form", "agent-connect-list", "agent-connect-name", "agent-connect-route",
    "agent-connect-status", "agent-copy-checklist", "agent-create", "agent-create-later",
    "agent-create-note", "agent-host-snippets", "agent-import-checklist", "agent-import-route",
    "agent-key-later", "agent-list-status", "agent-local-command", "agent-mcp-cli",
    "agent-mcp-json", "agent-mcp-toml", "agent-name-warning", "agent-other-types",
    "agent-packet-today", "agent-private-config", "agent-private-copy", "agent-private-details",
    "agent-retry", "agent-roster", "agent-roster-hint", "agent-route-hint", "agent-setup",
    "agent-setup-title", "agent-type-catalog", "connect-agent-button",
  ]) {
    const tag = id === "agent-connect-dialog" ? "dialog"
      : id === "agent-connect-form" ? "form"
      : id.endsWith("-list") ? "ul"
      : id === "agent-connect-access" || id === "agent-connect-expiry" ? "select"
      : id === "agent-connect-name" ? "input"
      : "button";
    const el = document.createElement(tag);
    el.id = id;
    if (id === "agent-connect-route") el.value = "mcp";
    document.body.append(el);
    els[id] = el;
  }
  const session = { member: { id: "m1" }, account: {}, roomId: "r1" };
  const client = {
    session,
    generation: 7,
    sequence: 1,
    ownsAccountSession: () => true,
    path: p => p,
    request: async () => ({ connections: [] }),
    refresh: async () => {},
    handleFailure: () => {},
  };
  const getState = () => ({
    room: { id: "r1", ownerId: "m1" },
    members: { m1: { id: "m1", active: true, kind: "human", permissions: ["manage_members"], revision: 3 } },
  });
  installAgentConnections({ client, getState });

  const button = els["connect-agent-button"];
  const dialog = els["agent-connect-dialog"];
  document.activeElement = button;
  fire(button, "click");
  assert.equal(dialog.open, true, "dialog opens on click");
  dialog.close(); // Escape path: the browser closes the dialog and fires close
  assert.equal(dialog.open, false, "dialog is closed");
  assert.equal(document.activeElement, button, "focus returns to the invoking button");
});

// ---------------------------------------------------------------------------
// src/gmail-ui.js — the compose dialog
// ---------------------------------------------------------------------------

test("gmail compose dialog returns focus to the compose button when closed", async t => {
  const dom = installDom(t);
  const { document, fire } = dom;
  const panel = document.createElement("section");
  panel.id = "inbox-panel";
  document.body.append(panel);
  const api = { request: async () => { throw new Error("unexpected gmail api call"); } };
  const controller = installGmailWorkspace({ api, ownerKey: () => "key" });
  controller.setStatus({ mailboxes: [{ id: "mb1", address: "a@b.c", state: "connected", canWrite: true }] });

  const dialog = document.querySelector(".gmail-compose");
  assert.ok(dialog, "compose dialog exists");
  const composeButton = document.querySelector("[data-compose]");
  assert.ok(composeButton, "compose button exists");
  document.activeElement = composeButton;
  fire(composeButton, "click");
  assert.equal(dialog.open, true, "compose dialog opens");
  dialog.close(); // Escape path
  assert.equal(document.activeElement, composeButton, "focus returns to the compose button");
});

// ---------------------------------------------------------------------------
// src/human-experience.js — project, assistant-setup, and share-result dialogs
// ---------------------------------------------------------------------------

function humanDom(dom) {
  const { document } = dom;
  for (const [id, tag] of [
    ["typing-indicator", "div"], ["message-input", "textarea"], ["composer-options", "div"],
    ["settings-dialog", "dialog"], ["human-advanced", "input"],
    ["human-project-open", "button"], ["assistant-setup", "button"],
  ]) {
    const el = document.createElement(tag);
    el.id = id;
    document.body.append(el);
  }
  const row = document.createElement("div");
  row.className = "composer-row";
  document.body.append(row);
  const ui = installHumanExperience({
    getState: () => ({
      room: { id: "r1", purpose: "Build things", ownerId: "m1" },
      members: { a1: { id: "a1", kind: "agent", active: true, permissions: ["accept_work"], displayName: "A1" } },
      workItems: { w1: { id: "w1", title: "Work", state: "working", revision: 3 } },
      messages: [],
    }),
    getSession: () => ({ member: { id: "m1", kind: "human" } }),
    client: { request: async () => { throw new Error("unexpected client call"); } },
    notice: () => {}, openWork: () => {}, openMessage: () => {},
    selectResult: () => {}, refreshTranscript: () => {},
  });
  return ui;
}

test("project dialog returns focus to its opener when closed", t => {
  const dom = installDom(t);
  const { document, fire } = dom;
  humanDom(dom);
  const openButton = document.querySelector("#human-project-open");
  const dialog = document.querySelector("#human-project-dialog");
  assert.ok(dialog, "project dialog exists");
  document.activeElement = openButton;
  fire(openButton, "click");
  assert.equal(dialog.open, true, "project dialog opens");
  dialog.close(); // Escape path
  assert.equal(document.activeElement, openButton, "focus returns to the project opener");
});

test("assistant setup dialog returns focus to its opener when closed", t => {
  const dom = installDom(t);
  const { document, fire } = dom;
  humanDom(dom);
  const openButton = document.querySelector("#assistant-setup");
  const dialog = document.querySelector("#room-assistant-setup");
  assert.ok(dialog, "setup dialog exists");
  document.activeElement = openButton;
  fire(openButton, "click");
  assert.equal(dialog.open, true, "setup dialog opens");
  dialog.close(); // Escape path
  assert.equal(document.activeElement, openButton, "focus returns to the setup opener");
});

test("share-result dialog returns focus to the invoking control when closed", t => {
  const dom = installDom(t);
  const { document, fire } = dom;
  const ui = humanDom(dom);
  const dialog = document.querySelector("#human-share-result");
  assert.ok(dialog, "share-result dialog exists");
  const trigger = document.createElement("button");
  trigger.id = "share-trigger";
  document.body.append(trigger);
  document.activeElement = trigger;
  assert.equal(ui.shareResult({ id: "w1", revision: 3 }), true, "share dialog opens");
  assert.equal(dialog.open, true, "dialog is open");
  dialog.close(); // Escape path
  assert.equal(document.activeElement, trigger, "focus returns to the invoking control");
});

// ---------------------------------------------------------------------------
// src/account-settings-ui.js — the account-deletion dialog
// ---------------------------------------------------------------------------

test("account-deletion dialog returns focus to the delete button when closed", async t => {
  const dom = installDom(t);
  const { document, fire } = dom;
  const accountClient = {
    currentSession: () => "sess",
    generation: 1,
    owns: () => true,
    request: async path => {
      if (path === "/api/auth/methods") return { methods: [], providers: null };
      if (path === "/api/account/deletion/plan") {
        return { summary: { text: "Plan" }, plan: { rooms: { blocked: [] } }, confirmationToken: null };
      }
      throw new Error("unexpected account request: " + path);
    },
  };
  const ui = createAccountSettingsUI({ accountClient });
  const container = document.createElement("div");
  document.body.append(container);
  await ui.mount(container);

  // Use the real markup: settingsHtml renders the delete button and dialog.
  const dialog = container.querySelector("[data-deletion-dialog]");
  const deleteButton = container.querySelector('[data-action="delete-account"]');
  assert.ok(dialog, "real deletion dialog exists");
  assert.ok(deleteButton, "real delete button exists");

  document.activeElement = deleteButton;
  fire(container, "click", { target: deleteButton });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dialog.open, true, "deletion dialog opens");
  dialog.close(); // Escape path
  assert.equal(document.activeElement, deleteButton, "focus returns to the delete button");
});

// ---------------------------------------------------------------------------
// src/updates-ui.js — the updates dialog
// ---------------------------------------------------------------------------

test("updates dialog returns focus to its topbar entry when closed", async t => {
  const dom = installDom(t);
  const { document, fire } = dom;
  const host = document.createElement("div");
  const topbar = document.createElement("div");
  topbar.className = "topbar-actions";
  host.append(topbar);
  document.body.append(host);
  mountUpdates({
    client: { roomRead: async () => ({ items: [], hasMore: false }) },
    host,
    getContext: () => "ctx",
  });
  const entry = host.querySelector("#topbar-updates");
  assert.ok(entry, "updates entry button exists");
  const dialog = host.querySelector("#updates-dialog");
  assert.ok(dialog, "updates dialog exists");
  document.activeElement = entry;
  fire(entry, "click");
  assert.equal(dialog.open, true, "updates dialog opens");
  await new Promise(resolve => setImmediate(resolve)); // let void load() settle
  dialog.close(); // Escape path
  assert.equal(document.activeElement, entry, "focus returns to the topbar entry");
});
