import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInboxRuleStore,
  SCHEMA_VERSION,
} from '../src/inbox-rule-store.mjs';

function makeDeps() {
  let now = 1000;
  let seq = 0;
  const saved = [];
  return {
    deps: {
      clock: () => now,
      id: () => `r-${(seq += 1)}`,
      storage: {
        load: () => null,
        save: (json) => saved.push(json),
      },
    },
    tick: (ms = 1) => {
      now += ms;
    },
    saved,
    storage: null,
  };
}

/** Build deps around a shared storage backend so two stores can hydrate from it. */
function makeSharedDeps() {
  let now = 1000;
  let seq = 0;
  const backend = { json: null };
  return {
    makeDeps() {
      return {
        clock: () => now,
        id: () => `r-${(seq += 1)}`,
        storage: {
          load: () => backend.json,
          save: (json) => {
            backend.json = json;
          },
        },
      };
    },
    tick: (ms = 1) => {
      now += ms;
    },
    backend,
  };
}

const GOOD_RULE = {
  name: 'boss mail',
  enabled: true,
  priority: 10,
  conditions: [{ field: 'from', op: 'contains', value: 'boss@corp.com' }],
  actions: [{ type: 'star' }],
};

test('create returns rule with id, timestamps, defaults', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  const rule = store.create({ ...GOOD_RULE });
  assert.equal(rule.id, 'r-1');
  assert.equal(rule.name, 'boss mail');
  assert.equal(rule.enabled, true);
  assert.equal(rule.priority, 10);
  assert.equal(rule.createdAt, 1000);
  assert.equal(rule.updatedAt, 1000);
});

test('create defaults enabled to true when omitted', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  const { enabled, ...rest } = GOOD_RULE;
  const rule = store.create(rest);
  assert.equal(rule.enabled, true);
});

test('get/list return frozen snapshots', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  const created = store.create({ ...GOOD_RULE });
  const fetched = store.get(created.id);
  assert.deepEqual(fetched, created);
  assert.ok(Object.isFrozen(fetched));
  assert.equal(store.list().length, 1);
});

test('get unknown id throws IR_NOT_FOUND', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  assert.throws(() => store.get('nope'), (e) => e.code === 'IR_NOT_FOUND');
});

test('update patches fields and bumps updatedAt', () => {
  const { deps, tick } = makeDeps();
  const store = createInboxRuleStore(deps);
  const created = store.create({ ...GOOD_RULE });
  tick(50);
  const updated = store.update(created.id, { name: 'new name', priority: 3 });
  assert.equal(updated.name, 'new name');
  assert.equal(updated.priority, 3);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.updatedAt, 1050);
  assert.equal(store.get(created.id).name, 'new name');
});

test('update unknown id throws IR_NOT_FOUND', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  assert.throws(() => store.update('nope', { name: 'x' }), (e) => e.code === 'IR_NOT_FOUND');
});

test('update rejects invalid payload with IR_INVALID_RULE', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  const created = store.create({ ...GOOD_RULE });
  assert.throws(() => store.update(created.id, { priority: -1 }), (e) => e.code === 'IR_INVALID_RULE');
  assert.throws(
    () => store.update(created.id, { conditions: [] }),
    (e) => e.code === 'IR_INVALID_RULE',
  );
});

test('delete removes the rule', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  const created = store.create({ ...GOOD_RULE });
  assert.equal(store.delete(created.id), true);
  assert.equal(store.list().length, 0);
  assert.throws(() => store.get(created.id), (e) => e.code === 'IR_NOT_FOUND');
});

test('delete unknown id throws IR_NOT_FOUND', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  assert.throws(() => store.delete('nope'), (e) => e.code === 'IR_NOT_FOUND');
});

test('create validates: missing name, bad field, bad op, bad action type', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  assert.throws(() => store.create({ ...GOOD_RULE, name: '' }), (e) => e.code === 'IR_INVALID_RULE');
  assert.throws(
    () =>
      store.create({
        ...GOOD_RULE,
        conditions: [{ field: 'bogus', op: 'contains', value: 'x' }],
      }),
    (e) => e.code === 'IR_INVALID_RULE',
  );
  assert.throws(
    () =>
      store.create({
        ...GOOD_RULE,
        conditions: [{ field: 'from', op: 'bogus', value: 'x' }],
      }),
    (e) => e.code === 'IR_INVALID_RULE',
  );
  assert.throws(
    () => store.create({ ...GOOD_RULE, actions: [{ type: 'bogus' }] }),
    (e) => e.code === 'IR_INVALID_RULE',
  );
  assert.throws(
    () => store.create({ ...GOOD_RULE, actions: [{ type: 'label' }] }),
    (e) => e.code === 'IR_INVALID_RULE',
  );
  assert.throws(
    () =>
      store.create({
        ...GOOD_RULE,
        conditions: [{ field: 'hasAttachment', op: 'contains', value: true }],
      }),
    (e) => e.code === 'IR_INVALID_RULE',
  );
});

test('create rejects invalid regex with IR_INVALID_RULE', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  assert.throws(
    () =>
      store.create({
        ...GOOD_RULE,
        conditions: [{ field: 'subject', op: 'regex', value: '([' }],
      }),
    (e) => e.code === 'IR_INVALID_RULE',
  );
  assert.throws(
    () =>
      store.create({
        ...GOOD_RULE,
        conditions: [{ field: 'subject', op: 'regex', value: 'a{2,1}' }],
      }),
    (e) => e.code === 'IR_INVALID_RULE',
  );
});

test('list sorts by priority then createdAt', () => {
  const shared = makeSharedDeps();
  const store = createInboxRuleStore(shared.makeDeps());
  store.create({ ...GOOD_RULE, name: 'late-low', priority: 5 });
  shared.tick(10);
  store.create({ ...GOOD_RULE, name: 'high', priority: 1 });
  shared.tick(10);
  store.create({ ...GOOD_RULE, name: 'early-low', priority: 5 });
  const names = store.list().map((r) => r.name);
  assert.deepEqual(names, ['high', 'late-low', 'early-low']);
});

test('condition matching: contains / equals / startsWith / regex', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  const msg = {
    from: 'alice@example.com',
    subject: 'Invoice #42 due',
    to: 'me@example.com',
    channel: 'email',
    hasAttachment: true,
  };
  const cases = [
    [{ field: 'from', op: 'contains', value: 'alice' }, true],
    [{ field: 'from', op: 'contains', value: 'bob' }, false],
    [{ field: 'from', op: 'equals', value: 'alice@example.com' }, true],
    [{ field: 'from', op: 'equals', value: 'alice' }, false],
    [{ field: 'subject', op: 'startsWith', value: 'Invoice' }, true],
    [{ field: 'subject', op: 'startsWith', value: '#42' }, false],
    [{ field: 'subject', op: 'regex', value: 'Invoice #\\d+' }, true],
    [{ field: 'subject', op: 'regex', value: '^Receipt' }, false],
    [{ field: 'channel', op: 'equals', value: 'email' }, true],
    [{ field: 'hasAttachment', op: 'equals', value: true }, true],
    [{ field: 'hasAttachment', op: 'equals', value: false }, false],
  ];
  for (const [condition, expected] of cases) {
    const rule = store.create({
      ...GOOD_RULE,
      conditions: [condition],
      actions: [{ type: 'markRead' }],
    });
    const matched = store.match(msg);
    assert.equal(matched.length, expected ? 1 : 0, JSON.stringify(condition));
    store.delete(rule.id);
  }
});

test('match requires ALL conditions to match', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  store.create({
    ...GOOD_RULE,
    conditions: [
      { field: 'from', op: 'contains', value: 'alice' },
      { field: 'subject', op: 'startsWith', value: 'Receipt' },
    ],
    actions: [{ type: 'archive' }],
  });
  const msg = { from: 'alice@example.com', subject: 'Invoice due' };
  assert.equal(store.match(msg).length, 0);
});

test('match returns actions ordered by rule priority', () => {
  const { deps, tick } = makeDeps();
  const store = createInboxRuleStore(deps);
  store.create({
    ...GOOD_RULE,
    name: 'slow',
    priority: 9,
    conditions: [{ field: 'from', op: 'contains', value: 'a' }],
    actions: [{ type: 'star' }],
  });
  tick(5);
  store.create({
    ...GOOD_RULE,
    name: 'fast',
    priority: 2,
    conditions: [{ field: 'from', op: 'contains', value: 'a' }],
    actions: [{ type: 'archive' }, { type: 'label', param: 'bills' }],
  });
  const actions = store.match({ from: 'a@x.com' });
  assert.deepEqual(
    actions.map((a) => a.type),
    ['archive', 'label', 'star'],
  );
  assert.equal(actions[0].ruleId, 'r-2');
  assert.ok(actions.every((a) => Object.isFrozen(a)));
});

test('match skips disabled rules; non-object message throws IR_INVALID_INPUT', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  const rule = store.create({ ...GOOD_RULE });
  store.setEnabled(rule.id, false);
  assert.equal(store.match({ from: 'boss@corp.com' }).length, 0);
  assert.throws(() => store.match(null), (e) => e.code === 'IR_INVALID_INPUT');
});

test('dryRun returns matched rules without side effects', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  const rule = store.create({ ...GOOD_RULE });
  store.create({
    ...GOOD_RULE,
    name: 'other',
    conditions: [{ field: 'from', op: 'contains', value: 'nobody' }],
  });
  const before = store.list().map((r) => r.updatedAt);
  const result = store.dryRun({ from: 'boss@corp.com' });
  assert.equal(result.length, 1);
  assert.equal(result[0].ruleId, rule.id);
  assert.equal(result[0].name, 'boss mail');
  assert.deepEqual(
    result[0].actions.map((a) => a.type),
    ['star'],
  );
  // Pure: store unchanged.
  assert.deepEqual(store.list().map((r) => r.updatedAt), before);
});

test('enable/disable flips enabled and notifies', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  const events = [];
  store.subscribe((e) => events.push(e));
  const rule = store.create({ ...GOOD_RULE });
  store.setEnabled(rule.id, false);
  assert.equal(store.get(rule.id).enabled, false);
  store.setEnabled(rule.id, true);
  assert.equal(store.get(rule.id).enabled, true);
  assert.equal(events.filter((e) => e.type === 'update').length, 2);
  assert.throws(() => store.setEnabled(rule.id, 'yes'), (e) => e.code === 'IR_INVALID_INPUT');
});

test('subscriber notifications fire for create/update/delete/restore', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  const events = [];
  const unsubscribe = store.subscribe((e) => events.push(e));
  const rule = store.create({ ...GOOD_RULE });
  store.update(rule.id, { name: 'renamed' });
  store.delete(rule.id);
  assert.deepEqual(
    events.map((e) => e.type),
    ['create', 'update', 'delete'],
  );
  assert.equal(events[0].ruleId, rule.id);
  unsubscribe();
  store.create({ ...GOOD_RULE });
  assert.equal(events.length, 3);
});

test('subscriber throw never breaks a mutation', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  store.subscribe(() => {
    throw new Error('boom');
  });
  const rule = store.create({ ...GOOD_RULE });
  assert.equal(rule.name, 'boss mail');
  assert.equal(store.list().length, 1);
});

test('subscribe with non-function throws IR_INVALID_INPUT', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  assert.throws(() => store.subscribe('nope'), (e) => e.code === 'IR_INVALID_INPUT');
});

test('snapshot carries schema version; restore round-trips', () => {
  const shared = makeSharedDeps();
  const store = createInboxRuleStore(shared.makeDeps());
  const a = store.create({ ...GOOD_RULE });
  shared.tick(10);
  store.create({ ...GOOD_RULE, name: 'second', enabled: false });
  const snap = store.snapshot();
  assert.equal(snap.schemaVersion, SCHEMA_VERSION);
  assert.equal(snap.rules.length, 2);

  const fresh = createInboxRuleStore(shared.makeDeps());
  fresh.restore(snap);
  const restored = fresh.list();
  assert.equal(restored.length, 2);
  assert.deepEqual(restored.map((r) => r.id), [a.id, 'r-2']);
  assert.equal(fresh.get(a.id).name, 'boss mail');
  assert.equal(fresh.get('r-2').enabled, false);
});

test('restore replaces existing rules', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  store.create({ ...GOOD_RULE, name: 'doomed' });
  const other = createInboxRuleStore(makeDeps().deps);
  const fresh = other.create({ ...GOOD_RULE, name: 'kept' });
  store.restore(other.snapshot());
  assert.deepEqual(store.list().map((r) => r.name), ['kept']);
  assert.equal(store.list()[0].id, fresh.id);
});

test('restore rejects corrupt snapshots with IR_CORRUPT_SNAPSHOT', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  assert.throws(() => store.restore(null), (e) => e.code === 'IR_CORRUPT_SNAPSHOT');
  assert.throws(() => store.restore({ schemaVersion: 999, rules: [] }), (e) => e.code === 'IR_CORRUPT_SNAPSHOT');
  assert.throws(() => store.restore({ schemaVersion: 1, rules: 'nope' }), (e) => e.code === 'IR_CORRUPT_SNAPSHOT');
  assert.throws(
    () => store.restore({ schemaVersion: 1, rules: [{ id: 'x' }] }),
    (e) => e.code === 'IR_CORRUPT_SNAPSHOT',
  );
  assert.throws(
    () =>
      store.restore({
        schemaVersion: 1,
        rules: [
          { ...GOOD_RULE, id: 'x', createdAt: 1, updatedAt: 1 },
          { ...GOOD_RULE, id: 'x', createdAt: 1, updatedAt: 1 },
        ],
      }),
    (e) => e.code === 'IR_CORRUPT_SNAPSHOT',
  );
});

test('constructor hydrates from injected storage; corrupt persisted JSON throws IR_CORRUPT_SNAPSHOT', () => {
  const { deps, saved } = makeDeps();
  const store = createInboxRuleStore(deps);
  const created = store.create({ ...GOOD_RULE });
  assert.ok(saved.length >= 1);
  const latest = JSON.parse(saved[saved.length - 1]);
  assert.equal(latest.schemaVersion, SCHEMA_VERSION);
  assert.equal(latest.rules[0].id, created.id);

  // Hydration: a new store over the same backend sees the rule.
  const backend = { json: saved[saved.length - 1] };
  let seq = 99;
  const hydrated = createInboxRuleStore({
    clock: () => 5000,
    id: () => `h-${(seq += 1)}`,
    storage: { load: () => backend.json, save: (j) => (backend.json = j) },
  });
  assert.equal(hydrated.list().length, 1);
  assert.equal(hydrated.get(created.id).name, 'boss mail');

  // Corrupt persisted JSON.
  assert.throws(
    () =>
      createInboxRuleStore({
        storage: { load: () => '{not json', save: () => {} },
      }),
    (e) => e.code === 'IR_CORRUPT_SNAPSHOT',
  );
});

test('storage write-through happens on every mutation', () => {
  const shared = makeSharedDeps();
  const store = createInboxRuleStore(shared.makeDeps());
  assert.equal(shared.backend.json, null);
  const rule = store.create({ ...GOOD_RULE });
  assert.ok(shared.backend.json.includes(rule.id));
  shared.tick(5);
  store.update(rule.id, { name: 'n2' });
  assert.ok(shared.backend.json.includes('n2'));
  store.setEnabled(rule.id, false);
  assert.ok(shared.backend.json.includes('"enabled":false'));
  store.delete(rule.id);
  assert.ok(shared.backend.json.includes('"rules":[]'));
});

test('storage failure throws IR_STORAGE', () => {
  const boom = {
    load: () => null,
    save: () => {
      throw new Error('disk full');
    },
  };
  const store = createInboxRuleStore({ storage: boom });
  assert.throws(() => store.create({ ...GOOD_RULE }), (e) => e.code === 'IR_STORAGE');
  assert.throws(
    () =>
      createInboxRuleStore({
        storage: {
          load: () => {
            throw new Error('nope');
          },
          save: () => {},
        },
      }),
    (e) => e.code === 'IR_STORAGE',
  );
});

test('coded-error contract: every failure exposes a code property', () => {
  const { deps } = makeDeps();
  const store = createInboxRuleStore(deps);
  const failures = [
    () => store.get('missing'),
    () => store.update('missing', { name: 'x' }),
    () => store.delete('missing'),
    () => store.create({}),
    () => store.match(42),
    () => store.dryRun('nope'),
    () => store.restore({}),
    () => store.subscribe(7),
  ];
  for (const fn of failures) {
    try {
      fn();
      assert.fail('expected a coded error');
    } catch (e) {
      assert.ok(e instanceof Error);
      assert.ok(/^IR_/.test(e.code), `code missing on: ${e.message}`);
      assert.ok(e.message.length > 0);
    }
  }
});
