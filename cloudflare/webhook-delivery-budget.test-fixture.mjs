// Local test fixture only. Measures Durable Object SQL rowsRead while the
// room store opens a production-sized webhook delivery table. Not a deploy
// entrypoint.
import { RoomStore } from "../server/store.mjs";
import { RECENT_WEBHOOK_DELIVERIES_SQL } from "../server/agent-plugin-store.mjs";
import { DurableDatabase, durableStorage } from "./storage.mjs";

const LEGACY_DELIVERY_SQL = `SELECT * FROM agent_webhook_deliveries WHERE delivery_id IN (
  SELECT delivery_id FROM agent_webhook_deliveries d2
  WHERE d2.subscription_id = agent_webhook_deliveries.subscription_id
  ORDER BY created_at DESC LIMIT 100
) ORDER BY created_at ASC`;

class MeteredDatabase extends DurableDatabase {
  constructor(storage, log) {
    super(storage);
    this.log = log;
  }
  #note(sql, cursor, returned) {
    const rowsRead = Number(cursor.rowsRead ?? 0);
    this.rowsRead = (this.rowsRead ?? 0) + rowsRead;
    this.log.push({ sql, rowsRead, returned });
  }
  exec(sql) {
    return durableStorage.transaction(this, () => {
      const cursor = this.storage.sql.exec(sql);
      const rows = cursor.toArray();
      this.#note(sql, cursor, rows.length);
      return rows;
    });
  }
  prepare(sql) {
    const all = (...args) => {
      const cursor = this.storage.sql.exec(sql, ...args);
      const rows = cursor.toArray();
      this.#note(sql, cursor, rows.length);
      return rows;
    };
    return {
      all,
      get: (...args) => all(...args)[0],
      run: (...args) => durableStorage.transaction(this, () => {
        all(...args);
        const changes = this.storage.sql.exec("SELECT changes() AS n");
        const n = changes.one().n;
        this.#note("SELECT changes() AS n", changes, 1);
        return { changes: n };
      }),
    };
  }
}

function deliveryReads(log) {
  return log.filter(entry => /^\s*SELECT\b/i.test(entry.sql) && /\bFROM\s+agent_webhook_deliveries\b/i.test(entry.sql))
    .reduce((sum, entry) => sum + entry.rowsRead, 0);
}

function openStore(storage, log) {
  const started = performance.now();
  const db = new MeteredDatabase(storage, log);
  const store = new RoomStore(null, { database: db, storagePlatform: durableStorage, integrity: "deferred" });
  return { store, ms: performance.now() - started };
}

function seed(store, count, subscriptions) {
  const payload = JSON.stringify({ data: { body: "x".repeat(3000) } });
  store.transaction(() => {
    const sub = store.db.prepare(`INSERT INTO agent_webhook_subs
      (subscription_id, agent_id, url, events_json, secret, enabled, created_at, journal_json)
      VALUES (?, 'agent', 'https://example.com/hook', '["message.posted"]', 'secret', 1, 1, '[]')`);
    for (let i = 0; i < subscriptions; i++) sub.run("sub-" + i);
    const delivery = store.db.prepare(`INSERT INTO agent_webhook_deliveries
      (delivery_id, idempotency_key, subscription_id, agent_id, event_type, payload_json, signature, state, attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, 'agent', 'message.posted', ?, 'sig', 'delivered', 1, ?, ?, ?)`);
    for (let i = 0; i < count; i++) {
      const id = "d-" + i;
      delivery.run(id, "key-" + id, "sub-" + (i % subscriptions), payload, i + 1, i + 1, i + 1);
    }
  });
}

export class DeliveryBudgetRoom {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    const url = new URL(request.url);
    const count = Number(url.searchParams.get("n"));
    const subscriptions = Number(url.searchParams.get("subs") ?? "8");
    const passes = Number(url.searchParams.get("passes") ?? "2");
    const oracle = url.searchParams.get("oracle") === "1";
    if (!Number.isInteger(count) || count < 1 || !Number.isInteger(passes) || passes < 1) {
      return Response.json({ error: "bad measure request" }, { status: 400 });
    }
    const scratch = [];
    const created = openStore(this.ctx.storage, scratch);
    seed(created.store, count, subscriptions);
    const measured = [];
    let last = null;
    let lastLog = [];
    for (let pass = 0; pass < passes; pass++) {
      const log = [];
      const opened = openStore(this.ctx.storage, log);
      last = opened.store;
      lastLog = log;
      const selects = log.filter(entry => entry.sql === RECENT_WEBHOOK_DELIVERIES_SQL);
      measured.push({
        deliveryRowsRead: deliveryReads(log),
        totalRowsRead: log.reduce((sum, entry) => sum + entry.rowsRead, 0),
        hydrationStatements: selects.length,
        schemaLookups: log.filter(entry => /\bsqlite_master\b/i.test(entry.sql)).length,
        ms: opened.ms,
        phases: opened.store.coldStart?.phases ?? null,
      });
    }
    const plans = last.db.prepare("EXPLAIN QUERY PLAN " + RECENT_WEBHOOK_DELIVERIES_SQL).all("sub").map(row => row.detail);
    const mark = lastLog.length;
    for (const id of last.agentPlugin.subs.keys()) last.agentPlugin.hydrateDeliveries(id);
    const loaded = last.agentPlugin.subs.get("sub-0").deliveries.length;
    const hydrateRowsRead = deliveryReads(lastLog.slice(mark));
    let legacyRowsRead = null;
    let legacyMs = null;
    if (oracle) {
      // The index is what production is missing. Drop it so this control
      // measures the correlated subquery the way a cold start does today.
      last.db.exec("DROP INDEX IF EXISTS agent_webhook_deliveries_sub_created");
      const log = [];
      const started = performance.now();
      const db = new MeteredDatabase(this.ctx.storage, log);
      db.prepare(LEGACY_DELIVERY_SQL).all();
      legacyRowsRead = deliveryReads(log);
      legacyMs = performance.now() - started;
    }
    return Response.json({
      measured, plans, legacyRowsRead, legacyMs, loaded, count, subscriptions,
      hydrateRowsRead,
    });
  }
}

export default {
  fetch(request, env) {
    const n = new URL(request.url).searchParams.get("n") ?? "0";
    return env.ROOM.getByName("delivery-budget-" + n).fetch(request);
  },
};
