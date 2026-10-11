// Fail-first: ask-card face action buttons and face lifecycle.
// The ask card is the center of the Room. Its buttons must fire the right
// action for the run's state, and the card itself must never go stale:
// no Resolve offered when a decision is needed, a Stop offered while a stop
// is already in flight, and a leftover card surviving sign-out or a room
// switch are all real bugs this pins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installHumanExperience } from '../src/human-experience.js';

// ---- minimal DOM double: just enough for installHumanExperience ----

const toCamel = dash => dash.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function matchSel(el, sel) {
  sel = sel.trim();
  const parts = sel.split(/\s+/);
  if (parts.length === 2) {
    if (!matchSel(el, parts[1])) return false;
    let parent = el.parentNode;
    while (parent) { if (matchSel(parent, parts[0])) return true; parent = parent.parentNode; }
    return false;
  }
  if (parts.length > 2) return false;
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('.')) return String(el.className || '').split(/\s+/).includes(sel.slice(1));
  const attr = sel.match(/^\[([\w-]+)(?:=(?:"([^"]*)"|([^\]]*)))?\]$/);
  if (attr) {
    const name = attr[1], want = attr[2] ?? attr[3];
    if (name.startsWith('data-')) {
      const key = toCamel(name.slice(5));
      if (!Object.hasOwn(el.dataset, key)) return false;
      return want === undefined || String(el.dataset[key]) === want;
    }
    if (el.getAttribute(name) === null) return false;
    return want === undefined || String(el.getAttribute(name)) === want;
  }
  return el.tagName === sel.toUpperCase();
}

class FakeEl {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this._attrs = {};
    this._listeners = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.textContent = '';
    this._html = '';
    this.className = '';
    this.id = '';
    this.type = '';
    this.value = '';
    this.tabIndex = 0;
    this.open = false;
    this.scrollTop = 0;
    this._before = [];
    this._auto = new Map();
    this._classSet = new Set();
  }
  get classList() {
    const set = this._classSet;
    return {
      toggle: (name, force) => { const on = force === undefined ? !set.has(name) : Boolean(force); if (on) set.add(name); else set.delete(name); return on; },
      add: (...names) => names.forEach(n => set.add(n)),
      remove: (...names) => names.forEach(n => set.delete(n)),
      contains: name => set.has(name),
    };
  }
  setAttribute(key, value) { this._attrs[key] = String(value); if (key === 'id') this.id = String(value); if (key === 'class') this.className = String(value); }
  getAttribute(key) { return Object.hasOwn(this._attrs, key) ? this._attrs[key] : null; }
  append(...els) { for (const el of els) { el.parentNode = this; this.children.push(el); } return this.children.length; }
  appendChild(el) { this.append(el); return el; }
  before(...els) { this._before.push(...els); }
  replaceChildren(...els) { for (const child of this.children) child.parentNode = null; this.children = []; if (els.length) this.append(...els); }
  insertAdjacentHTML(position, html) {
    assert.equal(position, 'beforeend');
    for (const match of String(html).matchAll(/<button([\s\S]*?)>([\s\S]*?)<\/button>/g)) {
      const button = new FakeEl('button');
      for (const attr of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) {
        if (attr[1] === 'class') button.className = attr[2];
        else if (attr[1].startsWith('data-')) button.dataset[toCamel(attr[1].slice(5))] = attr[2];
        else button.setAttribute(attr[1], attr[2]);
      }
      button.textContent = match[2];
      this.append(button);
    }
  }
  set innerHTML(html) { this._html = String(html); }
  get innerHTML() { return this._html; }
  addEventListener(name, handler) { (this._listeners[name] ??= []).push(handler); }
  _autoEl(sel) {
    if (!this._auto.has(sel)) {
      const el = new FakeEl('div');
      const id = sel.match(/#([\w-]+)/); if (id) el.id = id[1];
      const cls = sel.match(/\.([\w-]+)/); if (cls) el.className = cls[1];
      const tag = sel.match(/^([a-zA-Z][\w-]*)/);
      if (tag) el.tagName = tag[1].toUpperCase();
      if (/button|data-close|type=submit/i.test(sel)) el.tagName = 'BUTTON';
      if (/^select/i.test(sel)) el.tagName = 'SELECT';
      if (/^textarea/i.test(sel)) el.tagName = 'TEXTAREA';
      if (/^form/i.test(sel)) el.tagName = 'FORM';
      const submit = sel.match(/\[type=(?:"([^"]*)"|([^\]]*))\]/);
      if (submit) el.type = submit[1] ?? submit[2];
      for (const attr of sel.matchAll(/\[data-([\w-]+)\]/g)) el.dataset[toCamel(attr[1])] = '';
      el.parentNode = this;
      this.children.push(el);
      this._auto.set(sel, el);
    }
    return this._auto.get(sel);
  }
  querySelector(sel) {
    const walk = el => { for (const child of el.children) { if (matchSel(child, sel)) return child; const deep = walk(child); if (deep) return deep; } return null; };
    return walk(this) ?? this._autoEl(sel);
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = el => { for (const child of el.children) { if (matchSel(child, sel)) out.push(child); walk(child); } };
    walk(this);
    return out;
  }
  closest(sel) { let el = this; while (el) { if (matchSel(el, sel)) return el; el = el.parentNode; } return null; }
  contains(el) { if (!el || el === this) return el === this; return this.children.some(child => child.contains(el)); }
  focus() {}
  blur() {}
  click() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  reset() {}
}

function makeDocument() {
  const bySel = new Map();
  const body = new FakeEl('body');
  const autoTop = sel => { const el = new FakeEl('div'); const id = sel.match(/#([\w-]+)/); if (id) el.id = id[1]; return el; };
  return {
    hidden: false,
    activeElement: null,
    body,
    createElement: tag => new FakeEl(tag),
    createTextNode: text => ({
      data: text,
      tagName: '#TEXT',
      children: [],
      parentNode: null,
      dataset: {},
      appendData(s) { this.data += s; },
      replaceData(start, len, s) { this.data = this.data.slice(0, start) + s + this.data.slice(start + len); },
    }),
    querySelector(sel) { if (!bySel.has(sel)) bySel.set(sel, autoTop(sel)); return bySel.get(sel); },
    querySelectorAll() { return []; },
  };
}

function fixture(t) {
  const prev = { document: globalThis.document, sessionStorage: globalThis.sessionStorage, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  const doc = makeDocument();
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: doc });
  const store = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, writable: true, value: {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
  } });
  const timers = [];
  globalThis.setInterval = fn => { timers.push(fn); return timers.length; };
  globalThis.clearInterval = () => {};
  t.after(() => {
    for (const id of timers) prev.clearInterval(id);
    Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: prev.document });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, writable: true, value: prev.sessionStorage });
    globalThis.setInterval = prev.setInterval;
    globalThis.clearInterval = prev.clearInterval;
  });

  const state = {
    room: { id: 'room1', ownerId: 'human1', purpose: '' },
    members: {
      human1: { id: 'human1', kind: 'human', displayName: 'Human', active: true },
      agent1: { id: 'agent1', kind: 'agent', displayName: 'Agent', active: true, permissions: ['accept_work'] },
    },
    messages: [{ id: 'm1', body: 'Please summarize the thread', authorId: 'human1', channelId: 'general' }],
    channels: {},
    workItems: {},
  };
  const session = { member: { id: 'human1', kind: 'human' } };
  let projection = null;
  const client = { generation: 7, request: async () => projection };
  const calls = { startContribution: [], openMessage: [] };
  const ui = installHumanExperience({
    getState: () => state,
    getSession: () => session,
    client,
    notice: () => {},
    openWork: () => {},
    openMessage: id => calls.openMessage.push(id),
    startContribution: (messageId, wanted) => { calls.startContribution.push([messageId, wanted]); return true; },
    getContribution: () => null,
    endContribution: () => {},
    selectResult: () => {},
    refreshTranscript: () => {},
  });
  const face = () => doc.querySelector('#assistant-activity')._before[0];
  const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r)); };
  async function showRun(nextRun) {
    projection = { assistant: { name: 'Room', availability: 'connected', coordinatorMemberId: 'agent1', revision: 1 }, runs: [nextRun] };
    ui.sync();
    await settle();
  }
  return { doc, state, session, client, calls, ui, face, showRun, setProjection: next => { projection = next; } };
}

const run = (extra = {}) => ({
  id: 'r1', status: 'working', createdAt: Date.now() - 60_000, revision: 3, attemptId: 'a1',
  sourceMessageId: 'm1', initiatorId: 'human1', inputs: [], activity: [], ...extra,
});

// ---- Bug 1: the face says "Needs a decision" but offers no way to resolve it ----

test('the ask card offers Resolve direction for a run waiting on input', async t => {
  const f = fixture(t);
  await f.showRun(run({ status: 'needs_input' }));
  const buttons = f.face().querySelectorAll('button');
  const labels = buttons.map(b => b.textContent);
  const resolve = buttons.find(b => b.textContent === 'Resolve direction');
  assert.ok(resolve, `ask card must offer Resolve direction on needs_input, got [${labels.join(', ')}]`);
  assert.equal(resolve.dataset.resolve, 'true');
});

test('the face Resolve button dispatches a resolve contribution, not a generic one', async t => {
  const f = fixture(t);
  await f.showRun(run({ status: 'needs_input' }));
  const resolve = f.face().querySelectorAll('button').find(b => b.textContent === 'Resolve direction');
  assert.ok(resolve, 'precondition: resolve button exists');
  await f.face().onclick({ target: resolve });
  assert.deepEqual(f.calls.startContribution, [['m1', { action: 'resolve', runId: 'r1', expectedRevision: 3 }]]);
});

// ---- Bug 2: Stop is offered while a stop is already in flight ----

test('the ask card hides Stop while a stop is already in flight', async t => {
  const f = fixture(t);
  await f.showRun(run({ status: 'cancel_requested' }));
  const labels = f.face().querySelectorAll('button').map(b => b.textContent);
  assert.ok(!labels.includes('Stop'), `Stop must not show during cancel_requested, got [${labels.join(', ')}]`);
});

test('the ask card still offers Stop for open runs', async t => {
  const f = fixture(t);
  await f.showRun(run({ status: 'working' }));
  const labels = f.face().querySelectorAll('button').map(b => b.textContent);
  assert.ok(labels.includes('Stop'), `Stop must show for a working run, got [${labels.join(', ')}]`);
});

// ---- Bug 3: the card goes stale when the session or room changes ----

test('signing out hides the ask card instead of leaving the last card up', async t => {
  const f = fixture(t);
  await f.showRun(run({ status: 'working' }));
  assert.equal(f.face().hidden, false, 'precondition: card is visible while human');
  f.session.member.kind = 'agent';
  f.ui.sync();
  assert.equal(f.face().hidden, true, 'stale ask card must not survive sign-out');
});

test('switching rooms clears the ask card until the new room loads', async t => {
  const f = fixture(t);
  await f.showRun(run({ status: 'working' }));
  assert.equal(f.face().hidden, false, 'precondition: card is visible in room1');
  f.state.room.id = 'room2';
  f.client.request = () => new Promise(() => {}); // the new room has not loaded yet
  f.ui.sync();
  assert.equal(f.face().hidden, true, 'the previous room card must not flash in the new room');
});
