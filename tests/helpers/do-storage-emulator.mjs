// Test-only Durable Object storage emulator (backlog TST-12).
//
// The Worker runs RoomStore on DurableDatabase (cloudflare/storage.mjs) over
// ctx.storage.sql + ctx.storage.transactionSync. Node tests mostly run on the
// node:sqlite platform, so a bug that only shows on the DO surface ships
// unseen. This emulator gives Node a ctx.storage with the DO rules that bite:
//   - sql.exec refuses BEGIN / COMMIT / END / ROLLBACK / SAVEPOINT / RELEASE;
//     transactions go through transactionSync only.
//   - transactionSync nests (inner rollback keeps the outer transaction) and
//     refuses an async callback.
//   - cursors are single-pass: next, toArray, one (exactly one row or throw)
//     and raw share one position; columnNames, rowsRead and rowsWritten.
//   - multi-statement text runs every statement and returns the last cursor;
//     SQLite finds the statement boundaries (prepare + sourceSQL), so ';'
//     inside quotes, comments and trigger bodies does not split.
//   - raw() rows are positional, so duplicate column names keep both values.
//   - BLOB columns come back as ArrayBuffer, not Uint8Array/Buffer.
//   - foreign keys are on.
// It is a fidelity aid, not workerd. Run the cloudflare/*.check.mjs suites in
// miniflare for the real runtime.
import { DatabaseSync, constants } from "node:sqlite";

export class DoStorageError extends Error {
  constructor(message) { super(message); this.name = "DoStorageError"; }
}

const toDoValue = value => (value instanceof Uint8Array
  ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
  : value);

// DO cursors are single-pass iterators: next(), toArray(), one() and raw()
// all draw from the same position, so a row read once is gone. Rows arrive as
// positional arrays, so raw() keeps every column even when two share a name.
// Object rows keep the last column of a duplicated name.
function cursorOf(arrays, columnNames, rowsRead, rowsWritten) {
  const raws = arrays.map(row => row.map(toDoValue));
  const objectOf = row => Object.fromEntries(columnNames.map((name, index) => [name, row[index]]));
  let position = 0;
  const takeRaw = () => (position < raws.length ? { done: false, value: raws[position++] } : { done: true, value: undefined });
  const restRaw = () => { const rest = raws.slice(position); position = raws.length; return rest; };
  const cursor = {
    columnNames,
    rowsRead,
    rowsWritten,
    next() { const step = takeRaw(); return step.done ? step : { done: false, value: objectOf(step.value) }; },
    toArray() { return restRaw().map(objectOf); },
    one() {
      const rest = cursor.toArray();
      if (rest.length !== 1) throw new DoStorageError(`Expected exactly one result from SQL query, but got ${rest.length === 0 ? "no results" : "multiple results"}.`);
      return rest[0];
    },
    raw() {
      return {
        next: takeRaw,
        toArray: restRaw,
        [Symbol.iterator]() { return this; },
      };
    },
    [Symbol.iterator]() { return cursor; },
  };
  return cursor;
}

// Statement boundaries come from SQLite itself: prepare() compiles the first
// statement of the text and sourceSQL is exactly that statement. Quotes of
// every kind, comments and trigger bodies are therefore parsed by SQLite, not
// by a keyword counter here.
const isBlankSql = text => !text.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").replace(/[\s;]/g, "");

export class DoStorageEmulator {
  #allowTransactionControl = false;

  constructor({ filename = ":memory:" } = {}) {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA foreign_keys=ON");
    this.depth = 0;
    this.savepoints = 0;
    this.stats = { execs: 0, transactions: 0, rollbacks: 0, rejected: 0 };
    this.db.setAuthorizer(action => {
      if (!this.#allowTransactionControl && (action === constants.SQLITE_TRANSACTION || action === constants.SQLITE_SAVEPOINT)) {
        this.stats.rejected += 1;
        // Node converts a thrown authorizer error into SQLITE_DENY while
        // preserving the error, including our explicit storage-error API.
        throw new DoStorageError("SQL transaction statements are not allowed on Durable Object storage; use transactionSync");
      }
      return constants.SQLITE_OK;
    });
    this.sql = {
      exec: (query, ...args) => this.#exec(query, args),
      get databaseSize() { return 0; },
    };
  }

  #exec(query, args) {
    this.stats.execs += 1;
    for (const arg of args) {
      if (arg === undefined || typeof arg === "function" || (typeof arg === "object" && arg !== null && !(arg instanceof ArrayBuffer) && !ArrayBuffer.isView(arg))) {
        this.stats.rejected += 1;
        throw new DoStorageError(`Unsupported SQL binding type: ${arg === null ? "null" : typeof arg}`);
      }
    }
    const binds = args.map(arg => (arg instanceof ArrayBuffer ? new Uint8Array(arg) : arg));
    // DO runs every statement in the text and returns the cursor of the last
    // one, SELECT included. Bindings apply to the last statement. SQLite's
    // authorizer refuses transaction control regardless of leading trivia.
    let rest = String(query);
    if (isBlankSql(rest)) return cursorOf([], [], 0, 0);
    const changes = () => this.db.prepare("SELECT total_changes() AS n").get().n;
    const before = changes();
    let rows = [];
    let columns = [];
    while (!isBlankSql(rest)) {
      const statement = this.db.prepare(rest);
      const text = statement.sourceSQL;
      if (!text || !rest.startsWith(text)) {
        this.stats.rejected += 1;
        throw new DoStorageError("Unsupported SQL text: the emulator could not find the statement boundary");
      }
      rest = rest.slice(text.length);
      if (!isBlankSql(rest)) { statement.all(); continue; }
      statement.setReturnArrays(true);
      columns = statement.columns().map(column => column.name);
      rows = statement.all(...binds);
    }
    return cursorOf(rows, columns, rows.length, changes() - before);
  }

  #transactionControl(sql) {
    const previous = this.#allowTransactionControl;
    this.#allowTransactionControl = true;
    try { this.db.exec(sql); }
    finally { this.#allowTransactionControl = previous; }
  }

  transactionSync(fn) {
    if (typeof fn !== "function") throw new TypeError("transactionSync requires a callback");
    const outer = this.depth === 0;
    const name = `do_emulator_sp_${++this.savepoints}`;
    this.#transactionControl(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
    this.depth += 1;
    this.stats.transactions += 1;
    try {
      // Only the internal control statement gets an allowance, never fn().
      const result = fn();
      if (result && typeof result.then === "function") throw new DoStorageError("transactionSync callback must be synchronous");
      // A deferred foreign-key failure throws here, at COMMIT, and lands in
      // the catch below. Depth drops once, in finally, either way.
      this.#transactionControl(outer ? "COMMIT" : `RELEASE ${name}`);
      return result;
    } catch (error) {
      this.stats.rollbacks += 1;
      if (outer) { if (this.db.isTransaction !== false) this.#transactionControl("ROLLBACK"); } else this.#transactionControl(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  close() { this.db.close(); }
}

// A minimal DurableObjectState-like ctx for code that takes (ctx, env).
export function createDoContext(options) {
  const storage = new DoStorageEmulator(options);
  return {
    storage,
    id: { toString: () => "do-emulator", name: "do-emulator" },
    waitUntil: () => {},
    blockConcurrencyWhile: async fn => fn(),
  };
}
