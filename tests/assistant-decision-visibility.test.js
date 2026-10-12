import test from 'node:test';
import assert from 'node:assert/strict';
import { installHumanExperience } from '../src/human-experience.js';

// A strict, small DOM adapter exercises the mounted UI and its actual markup.
// It models disclosure visibility and focus; it is not browser/layout evidence.
function documentFixture() {
  const doc = { hidden: false, activeElement: null };
  const camel = name => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const decode = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, c) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[c]);
  function matches(node, selector) {
    const parts = selector.trim().split(/\s+/), last = parts.pop();
    const tokens = last.match(/^[a-z]+|#[\w-]+|\.[\w-]+|\[[^\]]+\]/g);
    assert.equal(tokens?.join(''), last, `unsupported selector: ${selector}`);
    if (!tokens.every(token => token[0] === '#' ? node.id === token.slice(1)
      : token[0] === '.' ? node.className.split(/\s+/).includes(token.slice(1))
      : token[0] === '[' ? (() => { const [, key, value] = token.match(/^\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]$/); const actual = node.getAttribute(key); return actual !== null && (value === undefined || actual === value); })()
      : node.tagName === token)) return false;
    return !parts.length || Boolean(node.parentNode?.closest(parts.join(' ')));
  }
  class Node {
    constructor(tagName = '#text', data = '') { Object.assign(this, { tagName, data, children: [], parentNode: null, dataset: {}, attrs: {}, style: {}, id: '', className: '', hidden: false, open: false, scrollTop: 0, checked: false }); }
    get length() { return this.data.length; }
    appendData(text) { this.data += text; }
    replaceData(start, length, text) { this.data = this.data.slice(0, start) + text + this.data.slice(start + length); }
    get isConnected() { return this === doc.body || Boolean(this.parentNode?.isConnected); }
    setAttribute(key, value) { if (key.startsWith('data-')) this.dataset[camel(key.slice(5))] = String(value); else if (['id', 'class', 'hidden', 'open'].includes(key)) this[key === 'class' ? 'className' : key] = ['hidden', 'open'].includes(key) ? true : String(value); else this.attrs[key] = String(value); }
    getAttribute(key) { return key.startsWith('data-') ? this.dataset[camel(key.slice(5))] ?? null : key === 'open' || key === 'hidden' ? (this[key] ? '' : null) : this.attrs[key] ?? null; }
    get classList() { const node = this; return { contains: value => node.className.split(/\s+/).includes(value), toggle(value, force) { const set = new Set(node.className.split(/\s+/).filter(Boolean)); const enabled = force ?? !set.has(value); if (enabled) set.add(value); else set.delete(value); node.className = [...set].join(' '); }, add(...names) { names.forEach(name => this.toggle(name, true)); }, remove(...names) { names.forEach(name => this.toggle(name, false)); } }; }
    remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; } }
    append(...nodes) { for (let node of nodes) { if (typeof node === 'string') node = new Node('#text', node); node.remove(); node.parentNode = this; this.children.push(node); } }
    before(...nodes) { assert.ok(this.parentNode, 'before needs an attached node'); for (const node of nodes) { node.remove(); node.parentNode = this.parentNode; this.parentNode.children.splice(this.parentNode.children.indexOf(this), 0, node); } }
    replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...nodes); }
    set textContent(text) { this.replaceChildren(new Node('#text', String(text))); }
    get textContent() { return this.tagName === '#text' ? this.data : this.children.map(node => node.textContent).join(''); }
    set innerHTML(html) {
      this.replaceChildren(); const stack = [this];
      for (const token of html.match(/<[^>]*>|[^<]+/g) ?? []) {
        if (token.startsWith('</')) { assert.equal(stack.pop().tagName, token.slice(2, -1)); continue; }
        if (!token.startsWith('<')) { stack.at(-1).append(new Node('#text', decode(token))); continue; }
        const [, tag, attrs] = token.match(/^<([\w-]+)([^>]*)>$/), child = new Node(tag);
        for (const [, key, a, b, c] of attrs.matchAll(/([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) child.setAttribute(key, decode(a ?? b ?? c ?? ''));
        stack.at(-1).append(child); if (!['input', 'br', 'hr'].includes(tag)) stack.push(child);
      }
      assert.equal(stack.length, 1, 'balanced template');
    }
    insertAdjacentHTML(position, html) { assert.equal(position, 'beforeend'); const node = new Node('div'); node.innerHTML = html; this.append(...node.children); }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.tagName !== '#text' && matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    closest(selector) { return matches(this, selector) ? this : this.parentNode?.closest(selector) ?? null; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    addEventListener(type, listener) { this[`on${type}`] = listener; }
    focus() { doc.activeElement = this; }
    reset() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  doc.body = new Node('body');
  doc.body.innerHTML = '<div id="typing-indicator"></div><div class="composer-row"><div id="composer-options"></div><textarea id="message-input"></textarea></div><dialog id="settings-dialog"></dialog><button id="connect-agent-button"></button><span id="work-options-summary"></span><input id="require-verification"><details id="people-panel"></details>';
  doc.createElement = tag => new Node(tag); doc.createTextNode = text => new Node('#text', text);
  doc.querySelector = selector => doc.body.querySelector(selector); doc.querySelectorAll = selector => doc.body.querySelectorAll(selector);
  return doc;
}

function visible(node) {
  if (!node?.isConnected) return false;
  for (let child = node, parent = node.parentNode; child; child = parent, parent = parent?.parentNode) {
    if (child.hidden || parent?.tagName === 'details' && !parent.open && child !== parent.querySelector('summary')) return false;
  }
  return true;
}

function fixture(t, viewer = 'owner') {
  const doc = documentFixture(), previous = Object.fromEntries(['document', 'sessionStorage', 'setInterval'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const storage = new Map();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } });
  let poll; globalThis.setInterval = callback => { poll = callback; };
  t.after(() => { for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  t.mock.method(Date, 'now', () => now); let now = 10_000;
  const state = { room: { id: 'room1', ownerId: 'owner' }, channels: {}, workItems: {}, members: { owner: { id: 'owner', kind: 'human', displayName: 'Alice' }, peer: { id: 'peer', kind: 'human', displayName: 'Bob' }, observer: { id: 'observer', kind: 'human', displayName: 'Casey' } }, messages: [] };
  const session = { member: state.members[viewer] }, calls = [];
  let projection = { assistant: { name: 'Room', availability: 'connected', coordinatorMemberId: 'agent' }, runs: [] }, failure = null;
  const client = { generation: 1, async request(path, options) { assert.equal(path, `/api/rooms/${state.room.id}/assistant`); assert.equal(options, undefined, 'test does not authorize a command'); if (failure) throw failure; return projection; } };
  const ui = installHumanExperience({ getState: () => state, getSession: () => session, client, notice() {}, openWork() {}, openMessage: id => calls.push(['message', id]), startContribution: (source, wanted) => { calls.push(['contribution', source, wanted]); return true; }, getContribution: () => null, endContribution() {}, selectResult() {}, refreshTranscript() {} });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { doc, state, session, client, ui, calls, async show(runs) { projection = { ...projection, runs }; state.messages = runs.map(run => ({ id: run.sourceMessageId, authorId: run.initiatorId, body: run.prompt, channelId: 'general' })); now += 4_000; ui.sync(); await settle(); }, async pollError() { failure = new Error('Read unavailable'); now += 4_000; poll(); await settle(); }, async sync() { ui.sync(); await settle(); } };
}

const decision = (extra = {}) => ({ id: 'older', sourceMessageId: 'ask-old', prompt: 'Which deadline should we use?', initiatorId: 'peer', status: 'needs_input', revision: 3, createdAt: 1, inputs: [], activity: [], ...extra });
const working = (extra = {}) => decision({ id: 'newer', sourceMessageId: 'ask-new', prompt: 'Draft the launch note', status: 'working', createdAt: 2, initiatorId: 'owner', ...extra });

test('an older decision and its requester and Resolve remain visible beside the newest working ask', async t => {
  const f = fixture(t); await f.show([working(), decision()]);
  const row = f.doc.querySelector('[data-assistant-run="older"]'), resolve = row.querySelector('[data-resolve]');
  assert.equal(visible(resolve), true, 'Resolve must not require opening Activity or the run');
  assert.match(row.querySelector('summary').textContent, /Bob/);
  assert.match(row.querySelector('summary').textContent, /Needs a decision/);
  assert.equal(f.doc.querySelector('#assistant-activity').open, false);
  assert.equal(f.doc.querySelector('#assistant-face .assistant-face-request').textContent, 'Draft the launch note');
  assert.equal(f.doc.querySelectorAll('[data-assistant-run="older"]').length, 1, 'one run row, not a duplicate card');
  await row.parentNode.onclick({ target: resolve, preventDefault() {} });
  assert.deepEqual(f.calls, [['contribution', 'ask-old', { action: 'resolve', runId: 'older', expectedRevision: 3 }]]);
  assert.equal(f.doc.activeElement, f.doc.querySelector('#message-input'));
});

test('all pending decisions remain visible; only the requester and owner can resolve them', async t => {
  const f = fixture(t, 'peer'); await f.show([working({ status: 'needs_input' }), decision()]);
  assert.deepEqual(f.doc.querySelectorAll('[data-assistant-run]').map(row => row.dataset.assistantRun), ['newer', 'older'], 'retain the server projection order');
  for (const id of ['older', 'newer']) assert.equal(visible(f.doc.querySelector(`[data-assistant-run="${id}"] summary`)), true);
  assert.equal(visible(f.doc.querySelector('[data-assistant-run="older"] [data-resolve]')), true);
  assert.equal(f.doc.querySelector('[data-assistant-run="newer"] [data-resolve]'), null);
  assert.equal(f.doc.querySelector('#assistant-face').hidden, true, 'the decision is not repeated as a face');
});

test('a working face becoming a decision keeps focus on its own visible request', async t => {
  const f = fixture(t); await f.show([working()]);
  f.doc.querySelector('#assistant-face [data-contribute-run]').focus();
  await f.show([working({ status: 'needs_input', revision: 4 }), decision({ id: 'third', sourceMessageId: 'ask-third', status: 'working', createdAt: 3 })]);
  assert.equal(visible(f.doc.activeElement), true);
  assert.equal(f.doc.activeElement.closest('[data-assistant-run]')?.dataset.assistantRun, 'newer', 'a newer working ask must not take the decision focus');
});

test('decision arrivals update a persistent status region without repeating it on activity repaints', async t => {
  const f = fixture(t); await f.show([working()]);
  const status = f.doc.querySelectorAll('[role="status"]').find(node => node.classList.contains('sr-only'));
  assert.ok(status, 'decisions have a live status even when the working face stays unchanged');
  await f.show([working(), decision()]); assert.match(status.textContent, /decision: 1/);
  const text = status.children[0];
  await f.show([working({ revision: 6 }), decision({ revision: 7 })]); assert.equal(status.children[0], text, 'no live-region rewrite for an unchanged decision count');
  await f.show([working(), decision({ status: 'queued' })]); assert.equal(status.textContent, '');
});

test('decision repaints preserve the focused action, revision, open disclosure and current order', async t => {
  const f = fixture(t); await f.show([working(), decision()]);
  const first = f.doc.querySelector('[data-assistant-run="older"]'); first.open = true; first.querySelector('[data-resolve]').focus();
  await f.show([working({ revision: 4 }), decision({ revision: 5 })]);
  assert.equal(f.doc.activeElement.dataset.resolve, 'true'); assert.equal(f.doc.activeElement.dataset.revision, '5'); assert.equal(visible(f.doc.activeElement), true);
  const row = f.doc.activeElement.closest('[data-assistant-run]'); assert.equal(row.open, true);
  row.querySelector('summary').focus(); await f.show([working(), decision({ revision: 6 })]);
  assert.equal(f.doc.activeElement.tagName, 'summary'); assert.equal(f.doc.activeElement.closest('[data-assistant-run]').dataset.assistantRun, 'older');
});

test('resolved decisions return to Activity with a visible focus fallback and no lingering Resolve', async t => {
  const f = fixture(t); await f.show([working(), decision()]); f.doc.querySelector('[data-resolve]').focus();
  await f.show([working(), decision({ status: 'queued', revision: 4 })]);
  assert.equal(f.doc.querySelectorAll('[data-resolve]').length, 0);
  assert.equal(f.doc.querySelector('[data-assistant-run="older"]').closest('#assistant-activity')?.id, 'assistant-activity');
  assert.equal(visible(f.doc.activeElement), true, 'focus never moves into closed Activity');
});

test('deleted prompts and non-decision states are never promoted, including during a failed read', async t => {
  const f = fixture(t); await f.show([working(), decision({ sourceDeleted: true }), decision({ id: 'failed', sourceMessageId: 'failed-source', status: 'failed' }), decision({ id: 'stalled', sourceMessageId: 'stalled-source', status: 'unknown' })]);
  assert.equal(f.doc.querySelectorAll('[data-resolve]').length, 0);
  await f.show([working(), decision()]);
  f.state.messages.find(message => message.id === 'ask-old').deletedAt = 1;
  await f.pollError(); await f.sync();
  assert.equal(f.doc.querySelectorAll('[data-resolve]').length, 0, 'a local tombstone suppresses stale projected decisions');
  assert.equal(f.doc.querySelector('[data-assistant-run="older"]').closest('#assistant-activity')?.id, 'assistant-activity');
});

for (const boundary of ['room', 'account', 'signout']) test(`${boundary} boundary clears promoted decisions before the next read`, async t => {
  const f = fixture(t); await f.show([working(), decision()]);
  if (boundary === 'room') f.state.room.id = 'room2';
  else if (boundary === 'account') { f.session.member = f.state.members.observer; f.client.generation++; }
  else f.session.member = null;
  f.client.request = () => new Promise(() => {}); await f.sync();
  assert.equal(f.doc.querySelectorAll('[data-resolve]').length, 0);
  assert.equal(f.doc.querySelectorAll('[data-assistant-run="older"]').length, 0);
});
