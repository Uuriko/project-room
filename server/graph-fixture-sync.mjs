// Offline Graph-shaped synchronization. No credentials, fetch, sockets or send API.
import { randomUUID } from "node:crypto";
import { emailConnection, emailDigest, emailInput, emailOpaqueId, emailSourceId, requireEmail } from "./email-envelope.mjs";
import { graphFolderChanges, normalizeGraphEmail } from "./graph-email.mjs";
import { ServiceError } from "./store.mjs";

const fail = (code, message) => { throw new ServiceError(409, code, message); };
const route = (connection, folderId) => "/v1.0/users/" + encodeURIComponent(connection.mailboxId)
  + "/mailFolders/" + encodeURIComponent(emailOpaqueId(folderId)) + "/messages/delta";

export function graphFixtureStart(connectionValue, folderId) {
  return "https://graph.microsoft.com" + route(emailConnection(connectionValue), folderId);
}
export function qualifyGraphFixtureCursor(cursor, connection, folderId) {
  requireEmail(typeof cursor === "string" && cursor.length <= 16384, "invalid_email_cursor");
  let url; try { url = new URL(cursor); } catch { requireEmail(false, "invalid_email_cursor"); }
  requireEmail(url.href === cursor && url.origin === "https://graph.microsoft.com" && !url.username && !url.password && !url.hash
    && url.pathname === route(emailConnection(connection), folderId), "invalid_email_cursor");
  return cursor; // Preserve the token and query exactly; never add select/top parameters.
}

export class RecordedGraphMailbox {
  #connection; #pages; #messages;
  constructor(recording) {
    emailInput(recording);
    this.#connection = emailConnection(recording.connection);
    const index = (rows, field) => {
      requireEmail(Array.isArray(rows) && rows.length <= 1000, "invalid_email_recording");
      const result = new Map();
      for (const row of rows) {
        requireEmail(row && (field === "cursor" && row[field] === null || typeof row[field] === "string")
          && !result.has(row[field]) && row.response && typeof row.response === "object", "invalid_email_recording");
        result.set(row[field], structuredClone(row.response));
      }
      return result;
    };
    this.#pages = index(recording.pages, "cursor"); this.#messages = index(recording.messages, "id");
  }
  get connection() { return structuredClone(this.#connection); }
  async page(cursor) {
    requireEmail(this.#pages.has(cursor), "email_recording_page_missing");
    return structuredClone(this.#pages.get(cursor));
  }
  async message(id) {
    requireEmail(this.#messages.has(id), "email_recording_message_missing");
    return structuredClone(this.#messages.get(id));
  }
}

// Prepare and apply are separate so callers retain the exact operation if an
// acknowledgement is lost. A new prepare rehydrates; it never rebases old content.
export async function prepareGraphFixturePage({ store, token, binding, connectionId, folderId, reader,
  requestId = randomUUID(), reset = false }) {
  requireEmail(reader instanceof RecordedGraphMailbox && typeof reset === "boolean", "email_fixture_reader_required");
  const captured = store.email.state(token, connectionId, folderId, binding), connection = captured.connection.profile;
  const guard = () => {
    const current = store.email.state(token, connectionId, folderId, binding);
    if (!current.canImport || current.connection.mode !== "fixture" || emailDigest(current.connection) !== emailDigest(captured.connection))
      fail("email_connection_changed", "Email connection changed. Reconnect before importing.");
    if ((current.folder?.revision ?? 0) !== (captured.folder?.revision ?? 0))
      fail("stale_email_page", "Sync progress changed. Prepare the current page again.");
  };
  guard();
  requireEmail(emailDigest(reader.connection) === emailDigest(connection), "email_recording_scope_changed");
  const cursor = reset || captured.needsReset ? null : captured.expectedCursor;
  if (cursor !== null) qualifyGraphFixtureCursor(cursor, connection, folderId);
  const response = await reader.page(cursor); guard();
  requireEmail(response && typeof response === "object", "email_fixture_page_failed");
  if (response.status === 410 || response.status >= 400 && response.status < 500 && response.code === "syncStateNotFound")
    fail("email_sync_reset_required", "Sync expired. Start a fresh scan; stored messages and drafts will remain.");
  requireEmail(response.status === 200, "email_fixture_page_failed");
  const page = graphFolderChanges(connection, folderId, response.body, { idType: "immutable" });
  qualifyGraphFixtureCursor(page.cursor, connection, folderId);
  const ids = [...new Set(page.changes.map(change => change.messageId))];
  requireEmail(ids.length <= 50, "email_sync_page_limit");
  const observations = [];
  // Hydrate even mixed/removed invalidations: order in a delta page is not a
  // current-state guarantee. A confirmed absence affects only this folder.
  for (const messageId of ids) {
    guard();
    let expectedSourceRevision = 0;
    try { expectedSourceRevision = store.inbox.read(token, emailSourceId(connection, messageId), binding).source.revision; }
    catch (error) { if (error.status !== 404) throw error; }
    const hydrated = await reader.message(messageId); guard();
    requireEmail(hydrated && typeof hydrated === "object", "email_fixture_hydration_failed");
    if (hydrated.status === 404 && hydrated.code === "ErrorItemNotFound") {
      observations.push({ kind: "absent", messageId }); continue;
    }
    requireEmail(hydrated.status === 200 && hydrated.message?.id === messageId, "email_fixture_hydration_failed");
    const envelope = normalizeGraphEmail(connection, hydrated.message, hydrated.options);
    observations.push(envelope.message.folderId === folderId
      ? { kind: "message", envelope, expectedSourceRevision } : { kind: "absent", messageId });
  }
  guard();
  return { action: "page.apply", requestId, connectionId, connectionRevision: connection.revision, folderId,
    expectedRevision: captured.folder?.revision ?? 0, expectedCursor: captured.expectedCursor, cursor: page.cursor,
    complete: page.complete, reset: reset || captured.needsReset, observations };
}
