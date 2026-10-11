// WAVE-500 guild 3 worker g3c8 — fail-first tests for src/updates-ui.js load().
// BUG 1: browsed page depth is a single shared counter. Switching filters
//   clobbers it, so returning to a filter replays only 1 page instead of the
//   already-browsed budget — browsed updates vanish from the list. The code's
//   own contract ("A return/refresh may replay only the already browsed
//   budget") and the capture/restore round-trip (filter + pageBudget) both
//   demand per-filter depth memory.
// BUG 2: the "Refresh updates" control hardcodes { budget: 1 }, discarding
//   browsed depth on refresh.
// BUG 3: the badge-count companion read (non-needs filters) is load-bearing:
//   when it fails, the whole list load aborts and "Loading updates…" sticks,
//   even though the main page window arrived fine. The badge must be
//   best-effort.
// Minimal fake DOM: mountUpdates only needs createElement/querySelector on a
// host, the parsed dialog template, and a tiny event system.

import test from "node:test";
import assert from "node:assert/strict";
import { mountUpdates } from "../src/updates-ui.js";

// ---------- minimal fake DOM ----------

function attrKey(name) {
  return name.startsWith("data-")
    ? name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    : name;
}

function matches(el, selector) {
  let sel = selector, pseudo = null;
  const pm = sel.match(/:([a-z]+)$/);
  if (pm) { pseudo = pm[1]; sel = sel.slice(0, pm.index); }
  let ok = false;
  if (sel.startsWith(".")) {
    ok = (el.className || "").split(/\s+/).includes(sel.slice(1));
  } else if (sel.startsWith("#")) {
    ok = el.id === sel.slice(1);
  } else if (sel.startsWith("[")) {
    const m = sel.match(/^\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]$/);
    const name = m[1], val = m[2] ?? m[3] ?? m[4];
    let actual;
    if (name.startsWith("data-")) actual = el.dataset?.[attrKey(name)];
    else if (name === "class") actual = el.className;
    else if (name === "id") actual = el.id;
    else if (name === "role") actual = el.role;
    else actual = el.attributes?.[name];
    ok = val === undefined ? actual !== undefined && actual !== null : String(actual) === val;
  } else {
    ok = el.tagName === sel.toUpperCase();
  }
  if (!ok) return false;
  if (pseudo === "enabled") return el.disabled === false;
  return true;
}

function queryAll(root, selector) {
  const out = [];
  const walk = node => {
    for (const child of node.children || []) {
      if (matches(child, selector)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function parseFragment(html, appendChild) {
  const fragChildren = [];
  const frag = { children: fragChildren, appendChild };
  const stack = [frag];
  const re = /<(\/?)([a-zA-Z0-9]+)((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, slash, tag, attrs, selfClose] = m;
    if (slash) { stack.pop(); continue; }
    const el = makeEl(tag.toLowerCase());
    const are = /([a-zA-Z-]+)(?:="([^"]*)")?/g;
    let am;
    while ((am = are.exec(attrs))) el.setAttribute(am[1], am[2] ?? "");
    stack[stack.length - 1].appendChild(el);
    if (!selfClose) stack.push(el);
  }
  return fragChildren;
}

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    dataset: {},
    attributes: {},
    className: "",
    id: "",
    type: "",
    role: "",
    textContent: "",
    hidden: false,
    disabled: false,
    tabIndex: 0,
    scrollTop: 0,
    open: false,
    _listeners: {},
    _innerHTML: "",
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === "id") this.id = value;
      else if (name === "class") this.className = value;
      else if (name === "role") this.role = value;
      else if (name === "hidden") this.hidden = true;
      else if (name === "disabled") this.disabled = true;
    },
    getAttribute(name) { return this.attributes[name] ?? null; },
    append(...nodes) { for (const n of nodes) this.appendChild(n); return this; },
    prepend(...nodes) {
      for (const n of nodes) {
        const node = typeof n === "object" ? n : textNode(n);
        node.parentNode = this;
        this.children.unshift(node);
      }
      return this;
    },
    appendChild(node) {
      const child = typeof node === "object" ? node : textNode(node);
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    replaceChildren(...nodes) {
      this.children = [];
      for (const n of nodes) this.appendChild(n);
    },
    addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) {
      this._listeners[type] = (this._listeners[type] ?? []).filter(f => f !== fn);
    },
    dispatchEvent(event) {
      event.target ??= this;
      for (const fn of this._listeners[event.type] ?? []) fn(event);
      return true;
    },
    closest(selector) {
      let node = this;
      while (node) { if (matches(node, selector)) return node; node = node.parentNode; }
      return null;
    },
    querySelector(sel) { return queryAll(this, sel)[0] ?? null; },
    querySelectorAll(sel) { return queryAll(this, sel); },
    focus() {},
    scrollIntoView() {},
    showModal() { this.open = true; },
    close() { this.open = false; },
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return this._innerHTML; },
    set(html) {
      this._innerHTML = html;
      this.children = [];
      for (const child of parseFragment(html, node => el.appendChild(node))) void child;
    },
  });
  return el;
}

function textNode(text) {
  const el = makeEl("#text");
  el.textContent = String(text);
  return el;
}

function makeDocument() {
  const listeners = {};
  return {
    createElement: tag => makeEl(tag),
    querySelector: () => null, // #main absent: MutationObserver wiring is skipped
    body: makeEl("body"),
    activeElement: null,
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] ?? []).filter(f => f !== fn);
    },
  };
}

// ---------- fake updates client ----------

const item = (id, extra = {}) => ({
  id,
  title: `Update ${id}`,
  kind: "mention",
  state: "unread",
  basisToken: `ub1_${"a".repeat(64)}`,
  roomId: "r1",
  sourceRef: { roomId: "r1" },
  ...extra,
});

function makeClient(pages, { failCompanion = false } = {}) {
  const calls = [];
  return {
    calls,
    generation: 1,
    session: { roomId: "r1", member: { id: "m1" } },
    async roomRead(path) {
      calls.push(path);
      await Promise.resolve();
      const url = new URL(path, "https://x.test");
      const state = url.searchParams.get("state");
      const kinds = url.searchParams.get("kinds");
      const limit = url.searchParams.get("limit");
      const cursor = url.searchParams.get("cursor");
      if (state === "actionable" && !kinds && limit === "100") {
        if (failCompanion) throw new Error("badge read failed");
        return { items: [], hasMore: false, cursor: null };
      }
      const page = pages[`${state}|${kinds ?? ""}|${cursor ?? ""}`];
      if (!page) throw new Error(`unexpected read ${path}`);
      return page;
    },
    async roomWrite() { throw new Error("not used in these tests"); },
  };
}

const pages = {
  "actionable||": { items: [item("a"), item("b")], cursor: "c1", hasMore: true },
  "actionable||c1": { items: [item("c"), item("d")], cursor: "c2", hasMore: true },
  "actionable||c2": {
    items: [item("e")], cursor: null, hasMore: false, incompleteSources: { sms: true },
  },
  "actionable|mention|": { items: [item("x")], cursor: null, hasMore: false },
};

function setup(clientOpts) {
  globalThis.document = makeDocument();
  globalThis.CSS = { escape: s => s };
  const client = makeClient(pages, clientOpts);
  const host = makeEl("div");
  const topbar = makeEl("div");
  topbar.className = "topbar-actions";
  const realQuery = host.querySelector.bind(host);
  host.querySelector = sel => (sel === ".topbar-actions" ? topbar : realQuery(sel));
  const api = mountUpdates({ client, host, getContext: () => "ctx1" });
  const dialog = host.querySelector("#updates-dialog");
  const list = dialog.querySelector(".updates-list");
  const status = dialog.querySelector("#updates-status");
  const loadMore = dialog.querySelector("#updates-load-more");
  const tabs = dialog.querySelector(".updates-filters");
  return { api, client, dialog, list, status, loadMore, tabs };
}

const flush = async (ticks = 40) => {
  for (let i = 0; i < ticks; i++) await new Promise(r => setImmediate(r));
};
const rowCount = list => list.querySelectorAll("[data-update-id]").length;
const click = el => el.dispatchEvent({ type: "click", detail: 1, target: el });
const clickTab = (tabs, id) => {
  const tab = tabs.querySelector(`[data-update-filter="${id}"]`);
  tabs.dispatchEvent({ type: "click", detail: 1, target: tab }); // bubbles to the tabs listener
};

async function browseThreePages(ctx) {
  ctx.api.open("needs");
  await flush();
  assert.equal(rowCount(ctx.list), 2, "page 1 loads");
  click(ctx.loadMore); await flush();
  click(ctx.loadMore); await flush();
  assert.equal(rowCount(ctx.list), 5, "three pages browsed");
}

test("returning to a filter replays ITS browsed budget, not the last filter's", async () => {
  const ctx = setup();
  await browseThreePages(ctx);
  clickTab(ctx.tabs, "mentions");
  await flush();
  assert.equal(rowCount(ctx.list), 1, "mentions shows its own page");
  clickTab(ctx.tabs, "needs");
  await flush();
  assert.equal(rowCount(ctx.list), 5, "needs replays its 3 browsed pages on return");
});

test("Refresh updates keeps the browsed depth instead of resetting to one page", async () => {
  const ctx = setup();
  await browseThreePages(ctx);
  assert.equal(ctx.loadMore.textContent, "Refresh updates", "end of list offers refresh");
  click(ctx.loadMore);
  await flush();
  assert.equal(rowCount(ctx.list), 5, "refresh replays the browsed budget");
});

test("a failed badge-count companion read does not abort the list load", async () => {
  const ctx = setup({ failCompanion: true });
  ctx.api.open("mentions");
  await flush();
  assert.equal(rowCount(ctx.list), 1, "list renders from the main window");
  assert.equal(ctx.status.textContent, "", "no stuck error status");
});
