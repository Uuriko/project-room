/**
 * task-lifecycle.mjs — Pure A2A task lifecycle state machine.
 *
 * Nothing here touches the network, the DOM, localStorage, or any secret —
 * it is a pure state machine. Persistence is write-through to the injected
 * `storage` dependency, so production wiring decides where task state lives.
 *
 * Task shape: { id, title, description?, agentId?, state, createdAt, updatedAt,
 * history[] }. Every history entry is frozen: { from, to, actor, note?, at }.
 * `history` is append-only: entries are added, never mutated or removed.
 *
 * Lifecycle:
 *   created → assigned → working → submitted → (completed | failed)
 *   Side transitions: any non-terminal → cancelled
 *                      working → blocked → working
 * Terminal states: completed, failed, cancelled (no outgoing transitions).
 *
 * Dependency injection (all via the `deps` parameter of createTaskLifecycle):
 *   - clock:   () => number   (ms epoch; default: Date.now)
 *   - id:      () => string   (task id generator; default: per-store counter)
 *   - storage: { load(), save(snapshot) }  (persistence; default: in-memory)
 *              load() must return the last snapshot object saved via save(),
 *              or null/undefined when nothing was persisted. The store
 *              hydrates from storage.load() at construction and writes every
 *              mutation back through storage.save() (write-through).
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   TL_NOT_FOUND          — unknown task id
 *   TL_INVALID_TRANSITION — operation not allowed from the current state
 *                           (includes unknown target states)
 *   TL_INVALID_TASK       — malformed task input (empty title, bad filter,
 *                           non-string agentId, non-function subscriber)
 *   TL_CORRUPT_SNAPSHOT   — snapshot()/restore() data fails schema validation
 *   TL_SUBSCRIBER_FAILED  — a transition subscriber threw (the transition
 *                           itself is already recorded and persisted first)
 * Failures are never silent.
 */

export const STATES = Object.freeze([
  'created',
  'assigned',
  'working',
  'blocked',
  'submitted',
  'completed',
  'failed',
  'cancelled',
]);

export const TERMINAL_STATES = Object.freeze(['completed', 'failed', 'cancelled']);

/** Schema version stamped on every snapshot(); restore() rejects mismatch. */
export const SCHEMA_VERSION = 1;

const TERMINAL_SET = new Set(TERMINAL_STATES);

/** Outgoing transitions per state; terminal states have none. */
const TRANSITIONS = Object.freeze({
  created: Object.freeze(['assigned', 'cancelled']),
  assigned: Object.freeze(['working', 'cancelled']),
  working: Object.freeze(['submitted', 'blocked', 'cancelled']),
  blocked: Object.freeze(['working', 'cancelled']),
  submitted: Object.freeze(['completed', 'failed', 'cancelled']),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

/** Throw a coded lifecycle error (never silent failures). */
function taskError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** Default persistence: an in-memory store. */
function defaultStorage() {
  let data = null;
  return {
    load: () => data,
    save: (snapshotData) => {
      data = snapshotData;
    },
  };
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFrozenHistoryEntry(entry) {
  return (
    isRecord(entry) &&
    (entry.from === null || (typeof entry.from === 'string' && STATES.includes(entry.from))) &&
    typeof entry.to === 'string' &&
    typeof entry.actor === 'string' &&
    typeof entry.at === 'number' &&
    (entry.note === undefined || entry.note === null || typeof entry.note === 'string') &&
    STATES.includes(entry.to)
  );
}

function validateSnapshotData(data) {
  if (!isRecord(data)) {
    throw taskError('TL_CORRUPT_SNAPSHOT', 'Snapshot must be an object', { data });
  }
  if (data.version !== SCHEMA_VERSION) {
    throw taskError(
      'TL_CORRUPT_SNAPSHOT',
      `Snapshot schema version mismatch: expected ${SCHEMA_VERSION}, got ${data.version}`,
      { version: data.version },
    );
  }
  if (!Array.isArray(data.tasks)) {
    throw taskError('TL_CORRUPT_SNAPSHOT', 'Snapshot tasks must be an array', {});
  }
  const seen = new Set();
  for (const task of data.tasks) {
    if (!isRecord(task)) {
      throw taskError('TL_CORRUPT_SNAPSHOT', 'Snapshot task must be an object', { task });
    }
    if (typeof task.id !== 'string' || task.id === '') {
      throw taskError('TL_CORRUPT_SNAPSHOT', 'Snapshot task id must be a non-empty string', { task });
    }
    if (seen.has(task.id)) {
      throw taskError('TL_CORRUPT_SNAPSHOT', `Snapshot has duplicate task id: ${task.id}`, { taskId: task.id });
    }
    seen.add(task.id);
    if (typeof task.title !== 'string' || task.title.trim() === '') {
      throw taskError('TL_CORRUPT_SNAPSHOT', 'Snapshot task title must be a non-empty string', { taskId: task.id });
    }
    if (!STATES.includes(task.state)) {
      throw taskError('TL_CORRUPT_SNAPSHOT', `Snapshot task has unknown state: ${task.state}`, { taskId: task.id });
    }
    if (typeof task.createdAt !== 'number' || typeof task.updatedAt !== 'number') {
      throw taskError('TL_CORRUPT_SNAPSHOT', 'Snapshot task timestamps must be numbers', { taskId: task.id });
    }
    if (!Array.isArray(task.history) || !task.history.every(isFrozenHistoryEntry)) {
      throw taskError('TL_CORRUPT_SNAPSHOT', 'Snapshot task history is malformed', { taskId: task.id });
    }
  }
}

/**
 * Create a new A2A task lifecycle store.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {{ load: () => object|null, save: (object) => void }} [deps.storage]
 */
export function createTaskLifecycle(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const storage = deps.storage ?? defaultStorage();

  let idCounter = 0;
  const newId = deps.id ?? (() => `task-${(idCounter += 1)}`);

  /** Internal task records, keyed by id. */
  const tasks = new Map();

  /** Transition subscribers: notified after every recorded transition. */
  const subscribers = new Set();

  function freezeTask(task) {
    return Object.freeze({
      id: task.id,
      title: task.title,
      description: task.description,
      agentId: task.agentId,
      state: task.state,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      history: Object.freeze(task.history.map((entry) => Object.freeze({ ...entry }))),
    });
  }

  function getTaskOrThrow(id) {
    const task = tasks.get(id);
    if (!task) {
      throw taskError('TL_NOT_FOUND', `Unknown task id: ${id}`, { taskId: id });
    }
    return task;
  }

  function notifySubscribers(event) {
    const failures = [];
    for (const subscriber of subscribers) {
      try {
        subscriber(event);
      } catch (subscriberError) {
        failures.push(subscriberError);
      }
    }
    if (failures.length > 0) {
      const err = taskError(
        'TL_SUBSCRIBER_FAILED',
        `Task ${event.taskId}: ${failures.length} subscriber(s) threw during notification`,
        { taskId: event.taskId, subscriberErrors: failures.map((e) => String(e && e.message ? e.message : e)) },
      );
      throw err;
    }
  }

  /** The full persistable snapshot (used for write-through storage.save). */
  function snapshotData() {
    return Object.freeze({
      version: SCHEMA_VERSION,
      exportedAt: clock(),
      tasks: Object.freeze([...tasks.values()].map(freezeTask)),
    });
  }

  function persist() {
    storage.save(snapshotData());
  }

  function applyTransition(task, to, actor, note) {
    if (!STATES.includes(to)) {
      throw taskError(
        'TL_INVALID_TRANSITION',
        `Unknown target state '${to}' for task ${task.id}`,
        { taskId: task.id, from: task.state, to },
      );
    }
    if (!TRANSITIONS[task.state].includes(to)) {
      throw taskError(
        'TL_INVALID_TRANSITION',
        `Cannot transition task ${task.id} from '${task.state}' to '${to}'`,
        { taskId: task.id, from: task.state, to },
      );
    }
    const from = task.state;
    const at = clock();
    task.state = to;
    task.updatedAt = at;
    task.history.push(
      Object.freeze({
        from,
        to,
        actor,
        note: note === undefined ? null : note,
        at,
      }),
    );
    persist();
    notifySubscribers(Object.freeze({ taskId: task.id, from, to, actor, note: note === undefined ? null : note, at }));
    return freezeTask(task);
  }

  // Hydrate from injected storage at construction; corruption fails loudly.
  const loaded = storage.load();
  if (loaded !== null && loaded !== undefined) {
    validateSnapshotData(loaded);
    for (const saved of loaded.tasks) {
      tasks.set(saved.id, {
        id: saved.id,
        title: saved.title,
        description: saved.description ?? '',
        agentId: saved.agentId ?? null,
        state: saved.state,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
        history: saved.history.map((entry) => Object.freeze({ ...entry })),
      });
    }
  }

  const store = {
    /**
     * Create a task in `created` state. Emits a create transition (from null)
     * to subscribers, so creation is observable like any other transition.
     */
    create({ title, description = '', agentId = null } = {}, actor = 'agent') {
      if (typeof title !== 'string' || title.trim() === '') {
        throw taskError('TL_INVALID_TASK', 'Task title must be a non-empty string', { title });
      }
      if (typeof description !== 'string') {
        throw taskError('TL_INVALID_TASK', 'Task description must be a string', { title });
      }
      if (agentId !== null && (typeof agentId !== 'string' || agentId === '')) {
        throw taskError('TL_INVALID_TASK', 'Task agentId must be a non-empty string or null', { title });
      }
      const id = newId();
      const at = clock();
      const task = {
        id,
        title,
        description,
        agentId,
        state: 'created',
        createdAt: at,
        updatedAt: at,
        history: [
          Object.freeze({ from: null, to: 'created', actor, note: null, at }),
        ],
      };
      tasks.set(id, task);
      persist();
      notifySubscribers(
        Object.freeze({ taskId: id, from: null, to: 'created', actor, note: null, at }),
      );
      return freezeTask(task);
    },

    /**
     * Assign a task to an agent: sets agentId and moves created → assigned.
     */
    assign(taskId, agentId, actor = 'agent') {
      const task = getTaskOrThrow(taskId);
      if (typeof agentId !== 'string' || agentId === '') {
        throw taskError('TL_INVALID_TASK', 'assign() requires a non-empty agentId string', { taskId: taskId });
      }
      if (task.state !== 'created') {
        throw taskError(
          'TL_INVALID_TRANSITION',
          `Cannot assign task ${task.id}: only tasks in 'created' can be assigned (current: '${task.state}')`,
          { taskId: task.id, state: task.state },
        );
      }
      task.agentId = agentId;
      return applyTransition(task, 'assigned', actor, `assigned to ${agentId}`);
    },

    /**
     * Move a task to a new state. Validated against the transition table;
     * appends a frozen history entry, persists, and notifies subscribers.
     */
    transition(taskId, to, actor = 'agent', note) {
      const task = getTaskOrThrow(taskId);
      return applyTransition(task, to, actor, note);
    },

    /** Read-only snapshot of a task (null if unknown). */
    get(taskId) {
      const task = tasks.get(taskId);
      return task ? freezeTask(task) : null;
    },

    /**
     * List tasks, optionally filtered by state and/or agentId.
     * Results are frozen snapshots, insertion-ordered.
     */
    list({ state, agentId } = {}) {
      if (state !== undefined && !STATES.includes(state)) {
        throw taskError('TL_INVALID_TASK', `Unknown state filter: '${state}'`, { state });
      }
      if (agentId !== undefined && (typeof agentId !== 'string' || agentId === '')) {
        throw taskError('TL_INVALID_TASK', 'agentId filter must be a non-empty string', { agentId });
      }
      return Object.freeze(
        [...tasks.values()]
          .filter((task) => (state === undefined || task.state === state))
          .filter((task) => (agentId === undefined || task.agentId === agentId))
          .map(freezeTask),
      );
    },

    /** Frozen append-only history of a task's transitions. */
    history(taskId) {
      const task = getTaskOrThrow(taskId);
      return Object.freeze(task.history.map((entry) => Object.freeze({ ...entry })));
    },

    /**
     * Subscribe to transition notifications. Returns an unsubscribe closure.
     * A subscriber receives { taskId, from, to, actor, note, at } after each
     * recorded transition (create counts as a transition from null).
     */
    subscribe(subscriber) {
      if (typeof subscriber !== 'function') {
        throw taskError('TL_INVALID_TASK', 'subscribe() requires a function', {});
      }
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },

    /** True when the task is in a terminal state. */
    isTerminal(taskId) {
      return TERMINAL_SET.has(getTaskOrThrow(taskId).state);
    },

    /** Frozen snapshot of all tasks plus the schema version. */
    snapshot() {
      return snapshotData();
    },

    /**
     * Replace the store contents with a snapshot. Validates the schema
     * version, task records, and history — any corruption throws
     * TL_CORRUPT_SNAPSHOT and the current store is left untouched.
     */
    restore(data) {
      validateSnapshotData(data);
      const next = new Map();
      for (const saved of data.tasks) {
        next.set(saved.id, {
          id: saved.id,
          title: saved.title,
          description: saved.description ?? '',
          agentId: saved.agentId ?? null,
          state: saved.state,
          createdAt: saved.createdAt,
          updatedAt: saved.updatedAt,
          history: saved.history.map((entry) => Object.freeze({ ...entry })),
        });
      }
      tasks.clear();
      for (const [id, task] of next) {
        tasks.set(id, task);
      }
      persist();
      return tasks.size;
    },
  };

  return Object.freeze(store);
}
