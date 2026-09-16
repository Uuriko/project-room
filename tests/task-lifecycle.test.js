import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskLifecycle, STATES, TERMINAL_STATES, SCHEMA_VERSION } from '../src/task-lifecycle.mjs';

/** Deterministic fake clock: each call advances 1s from a fixed epoch. */
function fakeClock() {
  let now = 1_700_000_000_000;
  return () => {
    now += 1000;
    return now;
  };
}

/** In-memory storage honoring the injected { load, save } contract. */
function memoryStorage(initial = null) {
  let data = initial;
  return {
    load: () => data,
    save: (snapshotData) => {
      data = snapshotData;
    },
    get saved() {
      return data;
    },
  };
}

function fresh(clockFn, storage) {
  const clock = clockFn ?? fakeClock();
  const store = storage ?? memoryStorage();
  return createTaskLifecycle({
    clock,
    id: (() => {
      let n = 0;
      return () => `task-${(n += 1)}`;
    })(),
    storage: store,
  });
}

function assertCoded(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'thrown value must be an Error');
    assert.equal(err.code, code);
    return true;
  });
}

test('module exports: states, terminal states, schema version', () => {
  assert.deepEqual([...STATES], [
    'created',
    'assigned',
    'working',
    'blocked',
    'submitted',
    'completed',
    'failed',
    'cancelled',
  ]);
  assert.deepEqual([...TERMINAL_STATES], ['completed', 'failed', 'cancelled']);
  assert.equal(SCHEMA_VERSION, 1);
  assert.ok(Object.isFrozen(STATES));
});

test('happy path: created → assigned → working → submitted → completed', () => {
  const lc = fresh();
  const created = lc.create({ title: 'Summarize thread', agentId: 'grokbot' }, 'coordinator');
  assert.equal(created.state, 'created');
  assert.equal(created.title, 'Summarize thread');
  assert.equal(created.agentId, 'grokbot');
  assert.equal(created.id, 'task-1');

  const assigned = lc.assign('task-1', 'instinct', 'coordinator');
  assert.equal(assigned.state, 'assigned');
  assert.equal(assigned.agentId, 'instinct');

  const working = lc.transition('task-1', 'working', 'instinct');
  assert.equal(working.state, 'working');

  const submitted = lc.transition('task-1', 'submitted', 'instinct', 'draft ready');
  assert.equal(submitted.state, 'submitted');

  const done = lc.transition('task-1', 'completed', 'john', 'looks good');
  assert.equal(done.state, 'completed');
  assert.ok(lc.isTerminal('task-1'));

  const hist = lc.history('task-1');
  assert.deepEqual(
    hist.map((h) => [h.from, h.to]),
    [
      [null, 'created'],
      ['created', 'assigned'],
      ['assigned', 'working'],
      ['working', 'submitted'],
      ['submitted', 'completed'],
    ],
  );
});

test('blocked round-trip: working → blocked → working', () => {
  const lc = fresh();
  lc.create({ title: 'Blocked demo' });
  lc.assign('task-1', 'instinct');
  lc.transition('task-1', 'working', 'instinct');
  const blocked = lc.transition('task-1', 'blocked', 'instinct', 'waiting on tool result');
  assert.equal(blocked.state, 'blocked');
  const resumed = lc.transition('task-1', 'working', 'instinct', 'tool answered');
  assert.equal(resumed.state, 'working');
  const hist = lc.history('task-1');
  assert.equal(hist[hist.length - 2].to, 'blocked');
  assert.equal(hist[hist.length - 1].to, 'working');
  assert.equal(hist[hist.length - 1].note, 'tool answered');
});

test('invalid transitions are rejected with TL_INVALID_TRANSITION', () => {
  const lc = fresh();
  lc.create({ title: 'Nope' });
  // skip a step
  assertCoded(() => lc.transition('task-1', 'working', 'instinct'), 'TL_INVALID_TRANSITION');
  // blocked only from working
  assertCoded(() => lc.transition('task-1', 'blocked', 'instinct'), 'TL_INVALID_TRANSITION');
  // unknown target state
  assertCoded(() => lc.transition('task-1', 'flying', 'instinct'), 'TL_INVALID_TRANSITION');
  // assign only from created
  lc.assign('task-1', 'instinct');
  assertCoded(() => lc.assign('task-1', 'codex'), 'TL_INVALID_TRANSITION');
  // terminal states have no outgoing transitions
  lc.transition('task-1', 'working', 'instinct');
  lc.transition('task-1', 'submitted', 'instinct');
  lc.transition('task-1', 'completed', 'john');
  for (const target of ['working', 'blocked', 'cancelled']) {
    assertCoded(() => lc.transition('task-1', target, 'instinct'), 'TL_INVALID_TRANSITION');
  }
  assert.ok(lc.isTerminal('task-1'));
});

test('cancel is allowed from every non-terminal state', () => {
  const fromStates = ['created', 'assigned', 'working', 'blocked', 'submitted'];
  const lc = fresh();
  for (const state of fromStates) {
    const t = lc.create({ title: `cancel from ${state}` });
    // walk the main line to the desired state
    if (['assigned', 'working', 'blocked', 'submitted'].includes(state)) lc.assign(t.id, 'instinct');
    if (['working', 'blocked', 'submitted'].includes(state)) lc.transition(t.id, 'working', 'instinct');
    if (state === 'blocked') lc.transition(t.id, 'blocked', 'instinct');
    if (state === 'submitted') lc.transition(t.id, 'submitted', 'instinct');
    assert.equal(lc.get(t.id).state, state);
    const cancelled = lc.transition(t.id, 'cancelled', 'john', 'no longer needed');
    assert.equal(cancelled.state, 'cancelled');
    assert.ok(lc.isTerminal(t.id));
  }
});

test('failed path: submitted → failed', () => {
  const lc = fresh();
  lc.create({ title: 'Doomed task' });
  lc.assign('task-1', 'instinct');
  lc.transition('task-1', 'working', 'instinct');
  lc.transition('task-1', 'submitted', 'instinct');
  const failed = lc.transition('task-1', 'failed', 'john', 'rejected: wrong approach');
  assert.equal(failed.state, 'failed');
  assert.ok(lc.isTerminal('task-1'));
  assertCoded(() => lc.transition('task-1', 'working', 'instinct'), 'TL_INVALID_TRANSITION');
});

test('history is append-only, ordered, and frozen', () => {
  const lc = fresh();
  lc.create({ title: 'History check' }, 'coordinator');
  lc.assign('task-1', 'instinct', 'coordinator');
  lc.transition('task-1', 'working', 'instinct', 'started');

  const hist = lc.history('task-1');
  assert.equal(hist.length, 3);
  assert.ok(Object.isFrozen(hist));
  for (const entry of hist) {
    assert.ok(Object.isFrozen(entry));
    assert.equal(typeof entry.at, 'number');
    assert.equal(typeof entry.actor, 'string');
  }
  // monotonic timestamps via the fake clock
  const times = hist.map((h) => h.at);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));

  // callers cannot mutate the store through a history snapshot
  assert.throws(() => {
    hist.push({ from: 'working', to: 'completed', actor: 'x', at: 0 });
  }, TypeError);
  assert.equal(lc.history('task-1').length, 3);

  // get() snapshots are frozen too
  const snap = lc.get('task-1');
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap.history));
});

test('list filters by state and agentId', () => {
  const lc = fresh();
  lc.create({ title: 'A', agentId: 'instinct' });
  lc.assign('task-1', 'instinct');
  lc.create({ title: 'B', agentId: 'grokbot' });
  lc.assign('task-2', 'grokbot');
  lc.transition('task-2', 'working', 'grokbot');
  lc.create({ title: 'C', agentId: 'instinct' });

  assert.equal(lc.list().length, 3);
  assert.deepEqual(lc.list({ state: 'created' }).map((t) => t.id), ['task-3']);
  assert.deepEqual(lc.list({ state: 'assigned' }).map((t) => t.id), ['task-1']);
  assert.deepEqual(lc.list({ agentId: 'instinct' }).map((t) => t.id), ['task-1', 'task-3']);
  assert.deepEqual(lc.list({ state: 'assigned', agentId: 'instinct' }).map((t) => t.id), ['task-1']);
  assert.deepEqual(lc.list({ agentId: 'nobody' }), []);
  assertCoded(() => lc.list({ state: 'flying' }), 'TL_INVALID_TASK');
  assertCoded(() => lc.list({ agentId: '' }), 'TL_INVALID_TASK');
});

test('subscribers are notified on every transition, in order', () => {
  const lc = fresh();
  const events = [];
  const unsubscribe = lc.subscribe((event) => events.push(event));
  assertCoded(() => lc.subscribe('not-a-function'), 'TL_INVALID_TASK');

  lc.create({ title: 'Notify me' }, 'coordinator');
  lc.assign('task-1', 'instinct', 'coordinator');
  lc.transition('task-1', 'working', 'instinct', 'go');

  assert.deepEqual(
    events.map((e) => [e.from, e.to, e.actor]),
    [
      [null, 'created', 'coordinator'],
      ['created', 'assigned', 'coordinator'],
      ['assigned', 'working', 'instinct'],
    ],
  );
  for (const event of events) {
    assert.equal(event.taskId, 'task-1');
    assert.equal(typeof event.at, 'number');
    assert.ok(Object.isFrozen(event));
  }
  assert.equal(events[2].note, 'go');

  // after unsubscribe, no more notifications
  unsubscribe();
  lc.transition('task-1', 'submitted', 'instinct');
  assert.equal(events.length, 3);
});

test('subscriber failures are coded, never silent (transition stands)', () => {
  const lc = fresh();
  lc.create({ title: 'Exploding subscriber' });
  lc.assign('task-1', 'instinct');
  lc.subscribe(() => {
    throw new Error('boom');
  });
  assertCoded(() => lc.transition('task-1', 'working', 'instinct'), 'TL_SUBSCRIBER_FAILED');
  // the transition itself was recorded and persisted first
  assert.equal(lc.get('task-1').state, 'working');
  assert.equal(lc.history('task-1').length, 3);
});

test('snapshot/restore round-trip preserves tasks and history', () => {
  const storage = memoryStorage();
  const lc = fresh(fakeClock(), storage);
  lc.create({ title: 'Persist me', description: 'keep', agentId: 'instinct' }, 'coordinator');
  lc.assign('task-1', 'instinct');
  lc.transition('task-1', 'working', 'instinct');

  // write-through: every mutation landed in injected storage
  assert.ok(storage.saved);
  assert.equal(storage.saved.version, SCHEMA_VERSION);
  assert.equal(storage.saved.tasks.length, 1);

  const snapshot = lc.snapshot();
  assert.equal(snapshot.version, SCHEMA_VERSION);
  assert.equal(typeof snapshot.exportedAt, 'number');
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.tasks));

  // restore into a fresh store with a different storage
  const lc2 = fresh();
  const restored = lc2.restore(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(restored, 1);
  const task = lc2.get('task-1');
  assert.equal(task.state, 'working');
  assert.equal(task.description, 'keep');
  assert.equal(task.agentId, 'instinct');
  assert.equal(lc2.history('task-1').length, 3);

  // hydrate at construction from existing storage data
  const lc3 = createTaskLifecycle({ clock: fakeClock(), storage });
  assert.equal(lc3.get('task-1').state, 'working');
  assert.equal(lc3.list().length, 1);
});

test('corrupt snapshots are rejected with TL_CORRUPT_SNAPSHOT', () => {
  const lc = fresh();
  lc.create({ title: 'Good task' });
  const good = JSON.parse(JSON.stringify(lc.snapshot()));

  const corruptedGood = JSON.parse(JSON.stringify(good));
  corruptedGood.version = 2; // future schema version: unknown shape
  const tamperedTask = JSON.parse(JSON.stringify(good));
  tamperedTask.tasks[0].state = 'deleted'; // valid shape fields, unknown state

  const corruptions = [
    null,
    'nope',
    42,
    {},
    corruptedGood,
    tamperedTask,
    { version: 999, tasks: [] },
    { version: SCHEMA_VERSION, tasks: 'not-an-array' },
    { version: SCHEMA_VERSION, tasks: [{ id: 'x' }] }, // missing title/state/etc
    { version: SCHEMA_VERSION, tasks: [{ id: '', title: 't', state: 'created', createdAt: 1, updatedAt: 1, history: [] }] },
    { version: SCHEMA_VERSION, tasks: [{ id: 'a', title: 't', state: 'flying', createdAt: 1, updatedAt: 1, history: [] }] },
    {
      version: SCHEMA_VERSION,
      tasks: [{ id: 'a', title: 't', state: 'created', createdAt: 1, updatedAt: 1, history: [{ from: null, to: 'nope', actor: 'x', at: 1 }] }],
    },
    {
      version: SCHEMA_VERSION,
      tasks: [
        { id: 'a', title: 't', state: 'created', createdAt: 1, updatedAt: 1, history: [] },
        { id: 'a', title: 't2', state: 'created', createdAt: 1, updatedAt: 1, history: [] },
      ],
    },
  ];
  for (const corrupt of corruptions) {
    assertCoded(() => lc.restore(corrupt), 'TL_CORRUPT_SNAPSHOT');
  }
  // the store is untouched after rejected restores
  assert.equal(lc.get('task-1').state, 'created');

  // corrupt data already sitting in storage fails loudly at construction
  const badStorage = memoryStorage({ version: 123, tasks: [] });
  assert.throws(
    () => createTaskLifecycle({ clock: fakeClock(), storage: badStorage }),
    (err) => err.code === 'TL_CORRUPT_SNAPSHOT',
  );
});

test('coded-error contract: every failure carries .code and never resolves silently', () => {
  const lc = fresh();
  // unknown ids
  assertCoded(() => lc.transition('nope', 'working'), 'TL_NOT_FOUND');
  assertCoded(() => lc.assign('nope', 'instinct'), 'TL_NOT_FOUND');
  assertCoded(() => lc.history('nope'), 'TL_NOT_FOUND');
  assertCoded(() => lc.isTerminal('nope'), 'TL_NOT_FOUND');
  assert.equal(lc.get('nope'), null); // read miss returns null per gate convention

  // malformed task input
  assertCoded(() => lc.create({ title: '' }), 'TL_INVALID_TASK');
  assertCoded(() => lc.create({}), 'TL_INVALID_TASK');
  assertCoded(() => lc.create({ title: 'x', description: 42 }), 'TL_INVALID_TASK');
  assertCoded(() => lc.create({ title: 'x', agentId: 42 }), 'TL_INVALID_TASK');

  lc.create({ title: 'ok' });
  assertCoded(() => lc.assign('task-1', ''), 'TL_INVALID_TASK');
  assertCoded(() => lc.assign('task-1', 42), 'TL_INVALID_TASK');
  assertCoded(() => lc.transition('task-1', ''), 'TL_INVALID_TRANSITION');

  // default actor applies when omitted
  const moved = lc.assign('task-1', 'instinct');
  assert.equal(moved.state, 'assigned');
  const last = lc.history('task-1').at(-1);
  assert.equal(last.actor, 'agent');
});
