// T4 — P0-3 pairing view reset (unit level), CURE-SPEC-5492.md §4.1.
// Stub-DOM pattern follows tests/human-push-ui.test.js (plain stub objects,
// no DOM renderer). installPairing reads document.querySelector for
// #agent-pairs / #agent-pair-list and document.getElementById for
// #agent-connect-dialog (src/pairing-ui.js). Test body proven by wave-1100
// cohort-05 lane-02 at base 1a8834ed (fails there: no reset exists).
import test from 'node:test';
import assert from 'node:assert/strict';
import { installPairing } from '../src/pairing-ui.js';

function stubList() {
  return {
    children: [],
    replaceChildren(...nodes) { this.children = [...nodes]; },
    append(...nodes) { this.children.push(...nodes); },
  };
}

function setup({ missing = false } = {}) {
  const section = { hidden: false };
  const list = stubList();
  const dialog = { open: false, addEventListener() {} };
  const prevDocument = globalThis.document;
  globalThis.document = {
    querySelector(selector) {
      if (missing) return null;
      if (selector === '#agent-pairs') return section;
      if (selector === '#agent-pair-list') return list;
      if (selector === '#agent-connect-dialog') return dialog;
      return null;
    },
    getElementById(id) { return id === 'agent-connect-dialog' ? dialog : null; },
    createElement() { throw new Error('createElement not expected in T4 setup'); },
  };
  const client = { session: { member: { id: 'owner' }, roomId: 'room-1' } };
  const getState = () => ({
    room: { ownerId: 'owner' },
    members: { owner: { id: 'owner', active: true, permissions: [] } },
  });
  const view = installPairing({ client, getState });
  return { view, section, list, restore() { globalThis.document = prevDocument; } };
}

test('installPairing returns a reset that hides the section and empties the pair list', () => {
  const { view, section, list, restore } = setup();
  try {
    // Simulate stale pair rows rendered in a previous room.
    list.append({ tag: 'li', textContent: 'stale pair 1' }, { tag: 'li', textContent: 'stale pair 2' });
    section.hidden = false;
    assert.equal(list.children.length, 2);
    assert.equal(typeof view.reset, 'function', 'pairing view must expose reset()');
    view.reset();
    assert.equal(section.hidden, true, 'reset() must hide #agent-pairs');
    assert.equal(list.children.length, 0, 'reset() must empty #agent-pair-list');
  } finally { restore(); }
});

test('installPairing missing-DOM stub also returns a reset function', () => {
  const { view, restore } = setup({ missing: true });
  try {
    assert.equal(typeof view.reset, 'function', 'missing-DOM stub must expose reset()');
    view.reset();
  } finally { restore(); }
});
