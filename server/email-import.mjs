// Account-owned fixture import. No OAuth credentials, network driver or send grant.
import { emailConnection, readEmailEnvelope, emailDigest, emailInput, emailOpaqueId, emailText, exactEmailFields } from "./email-envelope.mjs";
import { validId } from "../src/events.js";
import { ServiceError } from "./store.mjs";

const fail = (code, message, status = 409) => { throw new ServiceError(status, code, message); };
const require = (condition, code = "invalid_email_import") => { if (!condition) fail(code, "Email import could not be confirmed.", 422); };
const revision = value => Number.isSafeInteger(value) && value >= 0;
const same = (a, b) => a === undefined || b === undefined ? a === b : emailDigest(a) === emailDigest(b);
export const emailImportLimits = Object.freeze({ journalBytes: 16 * 1024 * 1024, commands: 5000 });
export const emailImportSchema = `
  CREATE TABLE private_email_connections (
    account_id TEXT NOT NULL REFERENCES accounts(id), id TEXT NOT NULL, provider TEXT NOT NULL, mailbox_id TEXT NOT NULL,
    data_json TEXT NOT NULL CHECK(json_valid(data_json)), PRIMARY KEY(account_id,id), UNIQUE(account_id,provider,mailbox_id)
  );
  CREATE TABLE private_email_folders (
    account_id TEXT NOT NULL, connection_id TEXT NOT NULL, folder_id TEXT NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json)),
    PRIMARY KEY(account_id,connection_id,folder_id), FOREIGN KEY(account_id,connection_id) REFERENCES private_email_connections(account_id,id)
  );
  CREATE TABLE private_email_commands (
    sequence INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, request_json TEXT NOT NULL CHECK(json_valid(request_json)), receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
    auth_epoch INTEGER NOT NULL, at INTEGER NOT NULL, UNIQUE(account_id,request_id)
  );
  CREATE TRIGGER private_email_commands_no_update BEFORE UPDATE ON private_email_commands BEGIN SELECT RAISE(ABORT,'email receipts are immutable'); END;
  CREATE TRIGGER private_email_commands_no_delete BEFORE DELETE ON private_email_commands BEGIN SELECT RAISE(ABORT,'email receipts are retained'); END;
`;
function validate(request) {
  emailInput(request);
  const common = ["action", "requestId", "connectionId", "expectedRevision"], fields = {
    "connection.configure": [...common, "profile"], "connection.disconnect": common,
    "page.apply": [...common, "connectionRevision", "folderId", "expectedCursor", "cursor", "complete", "reset", "observations"]
  }[request?.action];
  require(fields && exactEmailFields(request, fields) && validId(request.requestId) && validId(request.connectionId) && revision(request.expectedRevision));
  if (request.action === "connection.configure") {
    emailConnection(request.profile);
    require(request.profile.id === request.connectionId && request.profile.revision === request.expectedRevision + 1);
  }
  if (request.action === "page.apply") {
    require(revision(request.connectionRevision) && request.connectionRevision > 0 && typeof request.complete === "boolean" && typeof request.reset === "boolean");
    emailOpaqueId(request.folderId); emailText(request.cursor, 16384);
    if (request.expectedCursor !== null) emailText(request.expectedCursor, 16384);
    require(Array.isArray(request.observations) && request.observations.length <= 50);
    const ids = new Set();
    for (const observation of request.observations) {
      require(exactEmailFields(observation, observation?.kind === "message" ? ["kind", "envelope"] : ["kind", "messageId"]));
      require(["message", "absent"].includes(observation.kind));
      const id = observation.kind === "message" ? readEmailEnvelope(observation.envelope).message.id : emailOpaqueId(observation.messageId);
      require(!ids.has(id), "ambiguous_email_observation"); ids.add(id);
    }
  }
}
function currentConnection(connection, request, authEpoch) {
  if (!connection || connection.state !== "active" || connection.authEpoch !== authEpoch || connection.profile.revision !== request.connectionRevision)
    fail("email_connection_changed", "Email connection changed. Reconnect before importing.");
}
// Same deterministic transition drives live persistence and independent journal replay.
function plan(request, { accountId, authEpoch, at, connection, folder, source, mailbox, connectionCount }) {
  validate(request); require(revision(authEpoch) && revision(at));
  const receipt = { requestId: request.requestId, action: request.action, connectionId: request.connectionId };
  if (request.action.startsWith("connection.")) {
    if ((connection?.profile.revision ?? 0) !== request.expectedRevision) fail("stale_email_connection", "Connection changed. Refresh before editing.");
    let next;
    if (request.action === "connection.configure") {
      require(request.profile.accountId === accountId, "email_account_mismatch");
      if (connection && (connection.profile.provider !== request.profile.provider || connection.profile.mailboxId !== request.profile.mailboxId))
        fail("email_mailbox_changed", "Use the existing connection only for its original mailbox.");
      if (mailbox && mailbox !== request.connectionId) fail("email_mailbox_exists", "This account already has a connection for that mailbox.");
      if (!connection && connectionCount >= 20) fail("email_connection_limit", "Connection capacity reached.");
      next = { profile: request.profile, state: "active", mode: "fixture", authEpoch, updatedAt: at };
    } else {
      if (!connection) fail("email_connection_not_found", "Connection not found.", 404);
      next = { ...connection, profile: { ...connection.profile, revision: request.expectedRevision + 1 }, state: "disconnected", updatedAt: at };
    }
    return { connection: next, sources: [], receipt: { ...receipt, revision: next.profile.revision, state: next.state } };
  }
  currentConnection(connection, request, authEpoch);
  if ((folder?.revision ?? 0) !== request.expectedRevision) fail("stale_email_page", "Sync progress changed. Read the current checkpoint.");
  const changed = !folder || folder.connectionRevision !== request.connectionRevision;
  const cursor = changed ? null : folder.cursor;
  if (cursor !== request.expectedCursor || changed && !request.reset) fail("stale_email_cursor", "Sync context changed. Start a fresh scan.");
  if (request.cursor === request.expectedCursor && !request.complete) fail("nonprogressing_email_page", "The sync page did not advance.");
  const full = request.reset || !changed && !folder.complete && folder.scanMembers !== null;
  const members = new Set(folder?.members ?? []), scan = full ? new Set(request.reset ? [] : folder.scanMembers) : null;
  const target = scan ?? members, sources = [], imports = [];
  for (const observation of request.observations) {
    if (observation.kind === "absent") { target.delete(observation.messageId); continue; }
    const envelope = observation.envelope;
    require(same(envelope.connection, connection.profile) && envelope.message.folderId === request.folderId, "email_observation_scope_changed");
    const previous = source(envelope.sourceId);
    if (previous && (previous.data.adapter !== "email" || previous.data.envelope.connection.id !== request.connectionId))
      fail("email_source_collision", "An existing source has a different origin.");
    const unchanged = previous?.data.envelope.sourceVersion === envelope.sourceVersion;
    const sourceRevision = (previous?.revision ?? 0) + (unchanged ? 0 : 1);
    const inboxRequestId = unchanged ? null : "email-" + emailDigest([accountId, request.requestId, envelope.sourceId]);
    if (!unchanged) sources.push({ action: "source.import", requestId: inboxRequestId, sourceId: envelope.sourceId,
      expectedRevision: sourceRevision - 1, data: { adapter: "email", envelope } });
    imports.push({ sourceId: envelope.sourceId, sourceRevision, inboxRequestId }); target.add(envelope.message.id);
  }
  if (target.size > 1000) fail("email_folder_limit", "Folder pilot capacity reached.");
  const next = { revision: request.expectedRevision + 1, connectionRevision: request.connectionRevision, cursor: request.cursor,
    complete: request.complete, members: [...(scan && request.complete ? scan : members)].sort(),
    scanMembers: scan && !request.complete ? [...scan].sort() : null, updatedAt: at };
  return { folder: next, sources, receipt: { ...receipt, folderId: request.folderId, revision: next.revision,
    connectionRevision: next.connectionRevision, cursor: next.cursor, complete: next.complete, imports } };
}
export class EmailImport {
  constructor(store) { this.store = store; this.db = store.db; }
  connection(accountId, id) {
    const row = this.db.prepare("SELECT data_json FROM private_email_connections WHERE account_id=? AND id=?").get(accountId, id);
    return row ? JSON.parse(row.data_json) : null;
  }
  folder(accountId, connectionId, folderId) {
    const row = this.db.prepare("SELECT data_json FROM private_email_folders WHERE account_id=? AND connection_id=? AND folder_id=?").get(accountId, connectionId, folderId);
    return row ? JSON.parse(row.data_json) : null;
  }
  state(token, connectionId, folderId, binding) {
    return this.store.readTransaction(() => {
      require(validId(connectionId)); emailOpaqueId(folderId);
      const auth = this.store.inbox.auth(token, binding), connection = this.connection(auth.account.id, connectionId);
      if (!connection) fail("email_connection_not_found", "Connection not found.", 404);
      const folder = this.folder(auth.account.id, connectionId, folderId);
      const needsReset = !folder || folder.connectionRevision !== connection.profile.revision;
      const canImport = connection.state === "active" && connection.authEpoch === auth.account.authEpoch;
      return { contractVersion: 1, connection, folder, expectedCursor: needsReset ? null : folder.cursor, needsReset, canImport };
    });
  }
  apply(token, request, binding) {
    return this.store.transaction(() => {
      const auth = this.store.inbox.auth(token, binding), accountId = auth.account.id; validate(request);
      const connection = this.connection(accountId, request.connectionId);
      if (request.action === "page.apply") currentConnection(connection, request, auth.account.authEpoch);
      const prior = this.db.prepare("SELECT fingerprint,receipt_json FROM private_email_commands WHERE account_id=? AND request_id=?").get(accountId, request.requestId);
      const fingerprint = emailDigest(request);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail("idempotency_conflict", "Request ID already used for different import content.");
        return { receipt: JSON.parse(prior.receipt_json), duplicate: true };
      }
      if (request.action !== "connection.disconnect") {
        const usage = this.db.prepare("SELECT count(*) n, COALESCE(sum(length(CAST(request_json AS BLOB))),0) bytes FROM private_email_commands WHERE account_id=?").get(accountId);
        if (usage.n >= emailImportLimits.commands || usage.bytes + Buffer.byteLength(JSON.stringify(request)) > emailImportLimits.journalBytes)
          fail("email_import_limit", "Email import pilot capacity reached. Disconnect remains available.");
      }
      const at = this.store.now();
      const output = plan(request, { accountId, authEpoch: auth.account.authEpoch, at, connection,
        folder: request.action === "page.apply" ? this.folder(accountId, request.connectionId, request.folderId) : null,
        source: sourceId => {
          const row = this.db.prepare("SELECT revision FROM private_inbox_sources WHERE account_id=? AND id=?").get(accountId, sourceId);
          return row ? { revision: row.revision, data: this.store.inbox.version(accountId, sourceId, row.revision) } : null;
        },
        mailbox: request.profile ? this.db.prepare("SELECT id FROM private_email_connections WHERE account_id=? AND provider=? AND mailbox_id=?")
          .get(accountId, request.profile.provider, request.profile.mailboxId)?.id : null,
        connectionCount: this.db.prepare("SELECT count(*) n FROM private_email_connections WHERE account_id=?").get(accountId).n });
      if (output.connection) {
        const c = output.connection;
        this.db.prepare(`INSERT INTO private_email_connections VALUES(?,?,?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET data_json=excluded.data_json`)
          .run(accountId, request.connectionId, c.profile.provider, c.profile.mailboxId, JSON.stringify(c));
      }
      for (const source of output.sources) this.store.inbox.importSource(token, source, binding);
      if (output.folder) this.db.prepare(`INSERT INTO private_email_folders VALUES(?,?,?,?) ON CONFLICT(account_id,connection_id,folder_id) DO UPDATE SET data_json=excluded.data_json`)
        .run(accountId, request.connectionId, request.folderId, JSON.stringify(output.folder));
      this.db.prepare("INSERT INTO private_email_commands(account_id,request_id,fingerprint,request_json,receipt_json,auth_epoch,at) VALUES(?,?,?,?,?,?,?)")
        .run(accountId, request.requestId, fingerprint, JSON.stringify(request), JSON.stringify(output.receipt), auth.account.authEpoch, at);
      return { receipt: output.receipt, duplicate: false };
    });
  }
  verify() {
    return this.store.readTransaction(() => {
      const check = condition => { if (!condition) throw new Error("Private email import requires operator reconciliation"); };
      const normalize = sql => sql?.trim().replace(/;$/, "").replace(/\s+/g, " ");
      for (const sql of emailImportSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)) {
        const name = /^CREATE (?:TABLE|TRIGGER) ([a-z_]+)/.exec(sql.trim())[1];
        check(normalize(this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name)?.sql) === normalize(sql));
      }
      const connections = new Map(), folders = new Map(), sources = new Map(), referenced = new Set();
      for (const row of this.db.prepare("SELECT * FROM private_email_commands ORDER BY sequence").all()) {
        const request = JSON.parse(row.request_json), key = JSON.stringify([row.account_id, request.connectionId]);
        const folderKey = JSON.stringify([row.account_id, request.connectionId, request.folderId]);
        check(row.request_id === request.requestId && row.fingerprint === emailDigest(request));
        const accountConnections = [...connections.values()].filter(c => c.profile.accountId === row.account_id);
        const output = plan(request, { accountId: row.account_id, authEpoch: row.auth_epoch, at: row.at, connection: connections.get(key), folder: folders.get(folderKey),
          source: id => sources.get(JSON.stringify([row.account_id, id])), connectionCount: accountConnections.length,
          mailbox: request.profile ? accountConnections.find(c => c.profile.provider === request.profile.provider && c.profile.mailboxId === request.profile.mailboxId)?.profile.id : null });
        check(same(output.receipt, JSON.parse(row.receipt_json)));
        if (output.connection) connections.set(key, output.connection);
        if (output.folder) folders.set(folderKey, output.folder);
        for (const source of output.sources) {
          const inbox = this.db.prepare("SELECT request_json,receipt_json FROM private_inbox_commands WHERE account_id=? AND request_id=?").get(row.account_id, source.requestId);
          check(inbox && same(JSON.parse(inbox.request_json), source) && JSON.parse(inbox.receipt_json).revision === source.expectedRevision + 1);
          sources.set(JSON.stringify([row.account_id, source.sourceId]), { revision: source.expectedRevision + 1, data: source.data });
          referenced.add(JSON.stringify([row.account_id, source.requestId]));
        }
      }
      for (const row of this.db.prepare("SELECT account_id,request_id FROM private_inbox_commands WHERE json_extract(request_json,'$.action')='source.import'").all()) {
        check(referenced.delete(JSON.stringify([row.account_id, row.request_id])));
      }
      check(referenced.size === 0);
      const actualConnections = this.db.prepare("SELECT * FROM private_email_connections").all();
      check(actualConnections.length === connections.size);
      for (const row of actualConnections) {
        const expected = connections.get(JSON.stringify([row.account_id, row.id]));
        check(expected && row.provider === expected.profile.provider && row.mailbox_id === expected.profile.mailboxId && same(JSON.parse(row.data_json), expected));
      }
      const actualFolders = this.db.prepare("SELECT * FROM private_email_folders").all();
      check(actualFolders.length === folders.size);
      for (const row of actualFolders) check(same(JSON.parse(row.data_json), folders.get(JSON.stringify([row.account_id, row.connection_id, row.folder_id]))));
      return { connections: connections.size, folders: folders.size, sources: sources.size };
    });
  }
}
