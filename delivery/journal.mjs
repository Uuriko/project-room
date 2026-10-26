// Provider-independent delivery journal. The caller supplies a synchronous,
// serializable transaction over its own database (SQLite or transactionSync).
// Instantiate once per repository authority, not once per requesting Room.
export const deliverySchema = `
CREATE TABLE IF NOT EXISTS delivery_meta (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL);
INSERT OR IGNORE INTO delivery_meta(id, version) VALUES(1, 1);
CREATE TABLE IF NOT EXISTS delivery_leases (
  resource TEXT PRIMARY KEY, owner TEXT NOT NULL, generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_records (
  id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_effects (
  id TEXT PRIMARY KEY, resource TEXT NOT NULL, generation INTEGER NOT NULL,
  state TEXT NOT NULL, body TEXT NOT NULL, result TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_inbox (
  id TEXT PRIMARY KEY, body TEXT NOT NULL, received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL,
  entity TEXT NOT NULL, body TEXT NOT NULL
);`;

const string = value => {
  if (typeof value !== 'string' || !value.length || value.length > 512) throw new Error('Invalid delivery identifier');
  return value;
};
const json = value => {
  const body = JSON.stringify(value);
  if (body === undefined || body.length > 65536) throw new Error('Delivery record exceeds size limit');
  return body;
};
const duration = value => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3600000) throw new Error('Invalid lease duration');
  return value;
};

export function repositoryResource({ installation, repository, ref }) {
  string(installation); string(repository); string(ref);
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error('Invalid repository');
  return JSON.stringify(['github', installation, repository.toLowerCase(), ref]);
}

export class DeliveryJournal {
  constructor(db, { transaction, now = Date.now }) {
    if (typeof transaction !== 'function') throw new Error('Serializable transaction required');
    this.db = db;
    let depth = 0;
    this.transaction = fn => {
      if (depth) return fn();
      return transaction(() => {
        depth += 1;
        try { return fn(); } finally { depth -= 1; }
      });
    };
    this.now = now;
  }

  initialize() {
    return this.transaction(() => {
      const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_meta'").get();
      if (exists && this.db.prepare('SELECT version FROM delivery_meta WHERE id=1').get()?.version !== 1) {
        throw new Error('Unsupported delivery schema version');
      }
      this.db.exec(deliverySchema);
    });
  }

  audit(kind, entity, value) {
    this.db.prepare('INSERT INTO delivery_audit(at,kind,entity,body) VALUES(?,?,?,?)')
      .run(this.now(), kind, entity, json(value));
  }

  acquire(resource, owner, ttl) {
    string(resource); string(owner); duration(ttl);
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM delivery_leases WHERE resource=?').get(resource);
      const at = this.now();
      if (old && old.expires_at > at) return null;
      const lease = { resource, owner, generation: (old?.generation ?? 0) + 1, expiresAt: at + ttl };
      this.db.prepare(`INSERT INTO delivery_leases VALUES(?,?,?,?) ON CONFLICT(resource)
        DO UPDATE SET owner=excluded.owner,generation=excluded.generation,expires_at=excluded.expires_at`)
        .run(resource, owner, lease.generation, lease.expiresAt);
      this.audit('lease-acquired', resource, lease);
      return lease;
    });
  }

  assertLease(lease) {
    const row = this.db.prepare('SELECT * FROM delivery_leases WHERE resource=?').get(lease.resource);
    if (!row || row.owner !== lease.owner || row.generation !== lease.generation || row.expires_at <= this.now()) {
      throw new Error('Stale delivery lease');
    }
  }

  renew(lease, ttl) {
    duration(ttl);
    return this.transaction(() => {
      this.assertLease(lease);
      const expiresAt = this.now() + ttl;
      this.db.prepare('UPDATE delivery_leases SET expires_at=? WHERE resource=?').run(expiresAt, lease.resource);
      return { ...lease, expiresAt };
    });
  }

  release(lease) {
    return this.transaction(() => {
      this.assertLease(lease);
      this.db.prepare('UPDATE delivery_leases SET expires_at=0 WHERE resource=?').run(lease.resource);
      this.audit('lease-released', lease.resource, { generation: lease.generation });
    });
  }

  read(id) {
    const row = this.db.prepare('SELECT * FROM delivery_records WHERE id=?').get(string(id));
    return row ? { id: row.id, revision: row.revision, value: JSON.parse(row.body) } : null;
  }

  write(lease, id, expectedRevision, value) {
    string(id); const body = json(value);
    return this.transaction(() => {
      this.assertLease(lease);
      const previous = this.read(id);
      if ((previous?.revision ?? 0) !== expectedRevision) throw new Error('Delivery revision conflict');
      // Resource ownership is stored outside user-authored value and cannot move.
      if (previous && previous.value.resource !== lease.resource) throw new Error('Delivery resource mismatch');
      const revision = expectedRevision + 1;
      const stored = { resource: lease.resource, data: JSON.parse(body) };
      this.db.prepare(`INSERT INTO delivery_records VALUES(?,?,?) ON CONFLICT(id)
        DO UPDATE SET revision=excluded.revision,body=excluded.body`).run(id, revision, json(stored));
      this.audit('record-written', id, { revision, resource: lease.resource });
      return this.read(id);
    });
  }

  commit(lease, id, expectedRevision, value, effects = []) {
    return this.transaction(() => {
      const record = this.write(lease, id, expectedRevision, value);
      for (const effect of effects) this.prepare(lease, effect.id, effect.intent);
      return record;
    });
  }

  list(resource, { after = '', limit = 100 } = {}) {
    string(resource);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid delivery page size');
    // Resource is inside the trusted envelope, not the user-authored payload.
    return this.db.prepare("SELECT id,revision,body FROM delivery_records WHERE json_extract(body,'$.resource')=? AND id>? ORDER BY id LIMIT ?")
      .all(resource, after, limit).map(row => ({ id: row.id, revision: row.revision, value: JSON.parse(row.body) }));
  }

  receive(id, payload) {
    string(id); const body = json(payload);
    return this.transaction(() => {
      const old = this.db.prepare('SELECT body FROM delivery_inbox WHERE id=?').get(id);
      if (old) {
        if (old.body !== body) throw new Error('Delivery inbox identity conflict');
        return false;
      }
      this.db.prepare('INSERT INTO delivery_inbox VALUES(?,?,?)').run(id, body, this.now());
      this.audit('inbox-received', id, {});
      return true;
    });
  }

  effect(id) {
    const row = this.db.prepare('SELECT * FROM delivery_effects WHERE id=?').get(string(id));
    return row ? { ...row, body: JSON.parse(row.body), result: row.result === null ? null : JSON.parse(row.result) } : null;
  }

  prepare(lease, id, intent) {
    string(id); const body = json(intent);
    return this.transaction(() => {
      this.assertLease(lease);
      const old = this.effect(id);
      if (old) {
        if (old.resource !== lease.resource || JSON.stringify(old.body) !== body) throw new Error('Delivery effect identity conflict');
        return old;
      }
      this.db.prepare('INSERT INTO delivery_effects VALUES(?,?,?,?,?,?,?)')
        .run(id, lease.resource, lease.generation, 'pending', body, null, this.now());
      this.audit('effect-prepared', id, { resource: lease.resource });
      return this.effect(id);
    });
  }

  // Commit this before contacting a provider. A process death after this point
  // requires authoritative reconciliation, even when no request was actually sent.
  dispatch(lease, id) {
    return this.transaction(() => {
      this.assertLease(lease);
      const effect = this.effect(id);
      if (!effect || effect.resource !== lease.resource || effect.state !== 'pending') throw new Error('Effect is not dispatchable');
      this.db.prepare("UPDATE delivery_effects SET state='unknown',generation=?,updated_at=? WHERE id=?")
        .run(lease.generation, this.now(), id);
      this.audit('effect-dispatched', id, { generation: lease.generation });
      return this.effect(id);
    });
  }

  resolve(lease, id, result) {
    const body = json(result);
    return this.transaction(() => {
      this.assertLease(lease);
      const effect = this.effect(id);
      if (!effect || effect.resource !== lease.resource || effect.state !== 'unknown') throw new Error('Effect does not need reconciliation');
      // A new owner may record an authoritative provider receipt; it cannot
      // simply reset an uncertain effect to pending and send it again.
      this.db.prepare("UPDATE delivery_effects SET state='resolved',result=?,updated_at=? WHERE id=?")
        .run(body, this.now(), id);
      this.audit('effect-resolved', id, result);
      return this.effect(id);
    });
  }
}
