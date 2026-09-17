/**
 * inbox-rule-store.mjs — Pure in-memory CRUD store for inbox rules.
 *
 * An inbox rule is {id, name, enabled, priority, conditions[], actions[],
 * createdAt, updatedAt}. Rules are matched against incoming messages: every
 * enabled rule whose ALL conditions match contributes its actions, ordered by
 * rule priority (lower priority number first) then createdAt.
 *
 * Conditions: {field: from|subject|to|channel|hasAttachment,
 *              op: contains|equals|startsWith|regex, value}
 * Actions:    {type: archive|markRead|star|label|moveTo, param?}
 *
 * Pure in-memory store: NO network, NO DOM, NO secrets, NO localStorage.
 * Persistence is done through an injected `storage` dependency
 * ({load() -> string|null|undefined, save(snapshotJson: string)}) that is
 * written to on every mutation (write-through).
 *
 * Dependency injection (all via the `deps` parameter of createInboxRuleStore):
 *   - clock:   () => number  (ms epoch; default: Date.now)
 *   - id:      () => string  (rule id generator; default: per-store counter)
 *   - storage: { load(): string|null|undefined, save(json: string): void }
 *              (default: inert in-memory noop — nothing persists)
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   IR_NOT_FOUND       — unknown rule id
 *   IR_INVALID_RULE    — rule payload fails validation (incl. bad regex)
 *   IR_INVALID_INPUT   — non-rule input validation (bad message, bad snapshot, ...)
 *   IR_CORRUPT_SNAPSHOT — snapshot() payload is unreadable or wrong schema
 *   IR_STORAGE         — injected storage threw during load or write-through
 * Failures are never silent.
 */

export const SCHEMA_VERSION = 1;

export const CONDITION_FIELDS = Object.freeze(['from', 'subject', 'to', 'channel', 'hasAttachment']);
export const CONDITION_OPS = Object.freeze(['contains', 'equals', 'startsWith', 'regex']);
export const ACTION_TYPES = Object.freeze(['archive', 'markRead', 'star', 'label', 'moveTo']);

/** Throw a coded inbox-rule error (never silent failures). */
function ruleError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/** Compile a regex pattern safely; throws IR_INVALID_RULE on invalid patterns. */
function compileRegex(pattern) {
  try {
    return new RegExp(pattern);
  } catch (e) {
    throw ruleError('IR_INVALID_RULE', `Invalid regex pattern: ${pattern}`, {
      pattern,
      reason: e && e.message ? e.message : String(e),
    });
  }
}

function validateCondition(condition) {
  if (!isPlainObject(condition)) {
    throw ruleError('IR_INVALID_RULE', 'Condition must be an object', { condition });
  }
  if (!CONDITION_FIELDS.includes(condition.field)) {
    throw ruleError('IR_INVALID_RULE', `Invalid condition field: ${condition.field}`, {
      field: condition.field,
    });
  }
  if (!CONDITION_OPS.includes(condition.op)) {
    throw ruleError('IR_INVALID_RULE', `Invalid condition op: ${condition.op}`, { op: condition.op });
  }
  if (typeof condition.value !== 'string' && typeof condition.value !== 'boolean') {
    throw ruleError('IR_INVALID_RULE', 'Condition value must be a string or boolean', {
      value: condition.value,
    });
  }
  if (condition.field === 'hasAttachment') {
    if (condition.op !== 'equals') {
      throw ruleError('IR_INVALID_RULE', 'hasAttachment conditions require the equals op', {
        op: condition.op,
      });
    }
    if (typeof condition.value !== 'boolean') {
      throw ruleError('IR_INVALID_RULE', 'hasAttachment conditions require a boolean value', {
        value: condition.value,
      });
    }
  }
  if (condition.op === 'regex') {
    if (typeof condition.value !== 'string') {
      throw ruleError('IR_INVALID_RULE', 'regex conditions require a string pattern', {
        value: condition.value,
      });
    }
    // Reject invalid regex at create/update time, not at match time.
    compileRegex(condition.value);
  }
  return { field: condition.field, op: condition.op, value: condition.value };
}

function validateAction(action) {
  if (!isPlainObject(action)) {
    throw ruleError('IR_INVALID_RULE', 'Action must be an object', { action });
  }
  if (!ACTION_TYPES.includes(action.type)) {
    throw ruleError('IR_INVALID_RULE', `Invalid action type: ${action.type}`, { type: action.type });
  }
  const out = { type: action.type };
  if (action.param !== undefined) {
    if (typeof action.param !== 'string') {
      throw ruleError('IR_INVALID_RULE', 'Action param must be a string', { param: action.param });
    }
    out.param = action.param;
  }
  if ((action.type === 'label' || action.type === 'moveTo') && !isNonEmptyString(action.param)) {
    throw ruleError('IR_INVALID_RULE', `Action type '${action.type}' requires a non-empty param`, {
      type: action.type,
    });
  }
  return out;
}

/**
 * Validate a rule payload. When `forUpdate` is false, required fields must be
 * present; when true, only provided fields are validated (partial update).
 */
function validateRulePayload(payload, { forUpdate = false } = {}) {
  if (!isPlainObject(payload)) {
    throw ruleError('IR_INVALID_RULE', 'Rule payload must be an object', { payload });
  }
  const out = {};
  if (payload.name !== undefined || !forUpdate) {
    if (!isNonEmptyString(payload.name)) {
      throw ruleError('IR_INVALID_RULE', 'Rule name must be a non-empty string', { name: payload.name });
    }
    out.name = payload.name;
  }
  if (payload.enabled !== undefined) {
    if (typeof payload.enabled !== 'boolean') {
      throw ruleError('IR_INVALID_RULE', 'Rule enabled must be a boolean', { enabled: payload.enabled });
    }
    out.enabled = payload.enabled;
  }
  if (payload.priority !== undefined || !forUpdate) {
    if (!Number.isInteger(payload.priority) || payload.priority < 0) {
      throw ruleError('IR_INVALID_RULE', 'Rule priority must be a non-negative integer', {
        priority: payload.priority,
      });
    }
    out.priority = payload.priority;
  }
  if (payload.conditions !== undefined || !forUpdate) {
    if (!Array.isArray(payload.conditions) || payload.conditions.length === 0) {
      throw ruleError('IR_INVALID_RULE', 'Rule conditions must be a non-empty array', {
        conditions: payload.conditions,
      });
    }
    out.conditions = payload.conditions.map(validateCondition);
  }
  if (payload.actions !== undefined || !forUpdate) {
    if (!Array.isArray(payload.actions) || payload.actions.length === 0) {
      throw ruleError('IR_INVALID_RULE', 'Rule actions must be a non-empty array', {
        actions: payload.actions,
      });
    }
    out.actions = payload.actions.map(validateAction);
  }
  return out;
}

/**
 * Create a new inbox rule store.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {{load(): string|null|undefined, save(json: string): void}} [deps.storage]
 */
export function createInboxRuleStore(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const storage =
    deps.storage ??
    (() => {
      let held = null;
      return {
        load: () => held,
        save: (json) => {
          held = json;
        },
      };
    })();

  let idCounter = 0;
  const newId = deps.id ?? (() => `rule-${(idCounter += 1)}`);

  /** Internal rule records, keyed by id. */
  const rules = new Map();

  /** Subscribers notified on every mutation: (event) => void. */
  const subscribers = new Set();

  function getRuleOrThrow(id) {
    const rule = rules.get(id);
    if (!rule) {
      throw ruleError('IR_NOT_FOUND', `Unknown rule id: ${id}`, { ruleId: id });
    }
    return rule;
  }

  function snapshotRule(rule) {
    return Object.freeze({
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      priority: rule.priority,
      conditions: rule.conditions.map((c) => Object.freeze({ ...c })),
      actions: rule.actions.map((a) => Object.freeze({ ...a })),
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    });
  }

  /** Full store snapshot with schema version (JSON-serializable, frozen). */
  function snapshot() {
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      savedAt: clock(),
      rules: [...rules.values()].map((rule) => ({
        id: rule.id,
        name: rule.name,
        enabled: rule.enabled,
        priority: rule.priority,
        conditions: rule.conditions.map((c) => ({ ...c })),
        actions: rule.actions.map((a) => ({ ...a })),
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
      })),
    });
  }

  /** Write-through to the injected storage after every mutation. */
  function persist() {
    try {
      storage.save(JSON.stringify(snapshot()));
    } catch (e) {
      throw ruleError('IR_STORAGE', `Storage write failed: ${e && e.message ? e.message : e}`, {
        reason: e && e.message ? e.message : String(e),
      });
    }
  }

  /** Notify subscribers; a subscriber throw never breaks the mutation. */
  function notify(event) {
    for (const fn of [...subscribers]) {
      try {
        fn(event);
      } catch {
        // Subscriber errors are swallowed so notifications never corrupt state.
      }
    }
  }

  /**
   * Restore store contents from a snapshot produced by snapshot(). Replaces
   * all current rules. Corrupt payloads throw IR_CORRUPT_SNAPSHOT.
   */
  function restore(data) {
    if (!isPlainObject(data)) {
      throw ruleError('IR_CORRUPT_SNAPSHOT', 'Snapshot must be an object', { data });
    }
    if (data.schemaVersion !== SCHEMA_VERSION) {
      throw ruleError('IR_CORRUPT_SNAPSHOT', `Unsupported snapshot schemaVersion: ${data.schemaVersion}`, {
        schemaVersion: data.schemaVersion,
      });
    }
    if (!Array.isArray(data.rules)) {
      throw ruleError('IR_CORRUPT_SNAPSHOT', 'Snapshot rules must be an array', { rules: data.rules });
    }
    const restored = [];
    const seenIds = new Set();
    for (const entry of data.rules) {
      if (!isPlainObject(entry) || !isNonEmptyString(entry.id)) {
        throw ruleError('IR_CORRUPT_SNAPSHOT', 'Snapshot rule entry must have a string id', { entry });
      }
      if (seenIds.has(entry.id)) {
        throw ruleError('IR_CORRUPT_SNAPSHOT', `Duplicate rule id in snapshot: ${entry.id}`, {
          ruleId: entry.id,
        });
      }
      seenIds.add(entry.id);
      // Full re-validation catches schema drift and corrupt fields. Validation
      // failures mean the stored entry is corrupt — report them as such.
      let validated;
      try {
        validated = validateRulePayload(entry);
      } catch (e) {
        throw ruleError('IR_CORRUPT_SNAPSHOT', `Corrupt rule entry in snapshot: ${e.message}`, {
          ruleId: entry.id,
          reason: e.code,
        });
      }
      if (!Number.isFinite(entry.createdAt) || !Number.isFinite(entry.updatedAt)) {
        throw ruleError('IR_CORRUPT_SNAPSHOT', `Rule ${entry.id} has corrupt timestamps`, {
          ruleId: entry.id,
        });
      }
      restored.push({
        id: entry.id,
        ...validated,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      });
    }
    rules.clear();
    for (const rule of restored) {
      rules.set(rule.id, rule);
    }
    notify({ type: 'restore', ruleCount: restored.length, at: clock() });
    persist();
    return list();
  }

  /** Load persisted state from the injected storage at construction time. */
  function loadPersisted() {
    let raw;
    try {
      raw = storage.load();
    } catch (e) {
      throw ruleError('IR_STORAGE', `Storage load failed: ${e && e.message ? e.message : e}`, {
        reason: e && e.message ? e.message : String(e),
      });
    }
    if (raw === null || raw === undefined) return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw ruleError('IR_CORRUPT_SNAPSHOT', 'Persisted snapshot is not valid JSON', {
        reason: e && e.message ? e.message : String(e),
      });
    }
    restore(parsed);
  }

  function fieldValue(message, field) {
    if (field === 'hasAttachment') return Boolean(message.hasAttachment);
    const v = message[field];
    return typeof v === 'string' ? v : '';
  }

  function conditionMatches(condition, message) {
    if (condition.field === 'hasAttachment') {
      return condition.op === 'equals' && Boolean(message.hasAttachment) === condition.value;
    }
    const haystack = fieldValue(message, condition.field);
    const needle = String(condition.value);
    switch (condition.op) {
      case 'contains':
        return haystack.includes(needle);
      case 'equals':
        return haystack === needle;
      case 'startsWith':
        return haystack.startsWith(needle);
      case 'regex':
        // Pattern was validated at create/update time; compile is safe.
        return new RegExp(condition.value).test(haystack);
      default:
        throw ruleError('IR_INVALID_RULE', `Unknown condition op at match time: ${condition.op}`, {
          op: condition.op,
        });
    }
  }

  function ruleMatches(rule, message) {
    return rule.enabled && rule.conditions.every((c) => conditionMatches(c, message));
  }

  /** All rules sorted by priority (asc) then createdAt (asc). */
  function list() {
    return [...rules.values()]
      .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)
      .map(snapshotRule);
  }

  function create(payload, actor = 'agent') {
    const validated = validateRulePayload(payload);
    const at = clock();
    const rule = {
      id: newId(),
      name: validated.name,
      enabled: validated.enabled ?? true,
      priority: validated.priority,
      conditions: validated.conditions,
      actions: validated.actions,
      createdAt: at,
      updatedAt: at,
    };
    rules.set(rule.id, rule);
    persist();
    notify({ type: 'create', ruleId: rule.id, at, actor });
    return snapshotRule(rule);
  }

  function get(id) {
    return snapshotRule(getRuleOrThrow(id));
  }

  function update(id, patch, actor = 'agent') {
    const rule = getRuleOrThrow(id);
    const validated = validateRulePayload(patch ?? {}, { forUpdate: true });
    const at = clock();
    if (validated.name !== undefined) rule.name = validated.name;
    if (validated.enabled !== undefined) rule.enabled = validated.enabled;
    if (validated.priority !== undefined) rule.priority = validated.priority;
    if (validated.conditions !== undefined) rule.conditions = validated.conditions;
    if (validated.actions !== undefined) rule.actions = validated.actions;
    rule.updatedAt = at;
    persist();
    notify({ type: 'update', ruleId: id, at, actor });
    return snapshotRule(rule);
  }

  function remove(id, actor = 'agent') {
    getRuleOrThrow(id);
    rules.delete(id);
    const at = clock();
    persist();
    notify({ type: 'delete', ruleId: id, at, actor });
    return true;
  }

  function setEnabled(id, enabled, actor = 'agent') {
    if (typeof enabled !== 'boolean') {
      throw ruleError('IR_INVALID_INPUT', 'enabled must be a boolean', { enabled });
    }
    return update(id, { enabled }, actor);
  }

  /**
   * Match a message against all enabled rules. Returns the ordered list of
   * actions from rules whose ALL conditions match, ordered by rule priority
   * then createdAt. Pure: no side effects.
   */
  function match(message) {
    if (!isPlainObject(message)) {
      throw ruleError('IR_INVALID_INPUT', 'Message must be an object', { message });
    }
    const actions = [];
    for (const rule of [...rules.values()].sort(
      (a, b) => a.priority - b.priority || a.createdAt - b.createdAt,
    )) {
      if (ruleMatches(rule, message)) {
        for (const action of rule.actions) {
          actions.push(Object.freeze({ ruleId: rule.id, ...action }));
        }
      }
    }
    return actions;
  }

  /**
   * Dry-run: which rules would match a message, without any side effects.
   * Returns [{ruleId, name, priority, actions}] for matching enabled rules.
   */
  function dryRun(message) {
    if (!isPlainObject(message)) {
      throw ruleError('IR_INVALID_INPUT', 'Message must be an object', { message });
    }
    const matched = [];
    for (const rule of [...rules.values()].sort(
      (a, b) => a.priority - b.priority || a.createdAt - b.createdAt,
    )) {
      if (ruleMatches(rule, message)) {
        matched.push(
          Object.freeze({
            ruleId: rule.id,
            name: rule.name,
            priority: rule.priority,
            actions: rule.actions.map((a) => Object.freeze({ ...a })),
          }),
        );
      }
    }
    return matched;
  }

  const store = {
    create,
    get,
    update,
    delete: remove,
    list,
    setEnabled,
    match,
    dryRun,
    snapshot,
    restore,

    /** Subscribe to mutation events: fn({type, ruleId?, at, actor?}). Returns an unsubscribe fn. */
    subscribe(fn) {
      if (typeof fn !== 'function') {
        throw ruleError('IR_INVALID_INPUT', 'Subscriber must be a function', { fn });
      }
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };

  loadPersisted();

  return Object.freeze(store);
}
