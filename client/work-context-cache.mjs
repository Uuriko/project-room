// A private convenience cache, never an authorization or an atomic room snapshot.
import { createHash, randomUUID } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, writeFileSync, fsyncSync, mkdirSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = code => Object.assign(new Error(code), { code });
const integer = value => Number.isSafeInteger(value) && value >= 0;
function privateStat(stat, directory = false) {
  if (!(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1)
    || (stat.mode & 0o077) || !process.getuid || stat.uid !== process.getuid()) throw fail("context_cache_not_private");
}
function privateCache(directory, scope, workItemId, maxBytes) {
  const supplied = resolve(directory);
  privateStat(lstatSync(supplied), true);
  const root = realpathSync(supplied), path = join(root, "task-context");
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const initial = lstatSync(path); privateStat(initial, true);
  const file = join(path, digest({ scope, workItemId }) + ".json");
  const check = () => {
    const current = lstatSync(path); privateStat(current, true);
    if (current.dev !== initial.dev || current.ino !== initial.ino) throw fail("context_cache_changed");
  };
  const remove = () => { check(); try { unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; } };
  return {
    remove,
    read() {
      check(); let fd;
      try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = fstatSync(fd); privateStat(stat);
        if (stat.size > maxBytes) throw fail("context_cache_invalid");
        const bytes = Buffer.alloc(maxBytes + 1); let length = 0, count;
        while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null))) length += count;
        if (length > maxBytes) throw fail("context_cache_invalid");
        const value = JSON.parse(bytes.subarray(0, length).toString("utf8"));
        if (value.version !== 1 || value.scope !== scope || value.workItemId !== workItemId
          || value.integrity !== digest(value.discussion) || !Array.isArray(value.discussion?.items)
          || !integer(value.discussion.checkpoint) || typeof value.discussion.resumeToken !== "string"
          || !value.discussion.resumeToken || value.discussion.resumeToken.length > 4096) throw fail("context_cache_invalid");
        return { saved: value.discussion, invalid: false };
      } catch (error) {
        if (error.code === "ENOENT") return { saved: null, invalid: false };
        if (error.code === "ELOOP" || error.code === "context_cache_not_private") throw fail("context_cache_not_private");
        if (!(error instanceof SyntaxError) && error.code !== "context_cache_invalid") throw error;
        remove(); return { saved: null, invalid: true };
      } finally { if (fd !== undefined) closeSync(fd); }
    },
    write(discussion) {
      check();
      try { privateStat(lstatSync(file)); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const bytes = JSON.stringify({ version: 1, scope, workItemId, discussion, integrity: digest(discussion) });
      if (Buffer.byteLength(bytes) > maxBytes) throw fail("context_cache_limit");
      const temporary = join(path, "." + randomUUID() + ".tmp"); let fd;
      try {
        fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        privateStat(fstatSync(fd)); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
        check(); renameSync(temporary, file);
      } finally {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
  };
}

const identityFields = ["roomId", "viewerId", "viewerAccountId", "viewerAuthEpoch", "viewerSessionBinding", "viewerSessionRevision"];
const identity = value => identityFields.map(key => value[key] ?? null);
function contextScope(value, connection, workItemId) {
  if (value.roomId !== connection.roomId || value.viewerId !== connection.memberId || value.viewer?.id !== connection.memberId
    || value.work?.id !== workItemId || !integer(value.viewer.revision)) throw fail("context_scope_changed");
  return digest({ identity: identity(value), revision: value.viewer.revision });
}

export async function readResumablePreparation(client, workItemId, {
  connection, directory, maxBytes = 4 * 1024 * 1024, maxPages = 100, deadlineMs = 30000, signal
} = {}) {
  if (!connection?.origin || !connection.roomId || !connection.memberId || !connection.token || !directory
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16 * 1024 * 1024
    || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120000) throw fail("invalid_context_cache_options");
  const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]) : AbortSignal.timeout(deadlineMs);
  boundedSignal.throwIfAborted();
  const initial = await client.workContext(workItemId, { signal: boundedSignal });
  const initialScope = contextScope(initial, connection, workItemId);
  const scope = digest({ origin: connection.origin, roomId: connection.roomId, memberId: connection.memberId, tokenHash: digest(connection.token) });
  const cache = privateCache(directory, scope, workItemId, maxBytes);
  let { saved, invalid: reset } = cache.read();
  let pages = 0, receivedBytes = 0, delta = [], completed;
  const seen = new Set();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      let cursor;
      delta = [];
      try {
        while (pages < maxPages) {
          boundedSignal.throwIfAborted();
          const result = await client.workDiscussion(workItemId, { consistent: true, limit: 50, signal: boundedSignal,
            ...(cursor ? { cursor } : saved ? { resumeToken: saved.resumeToken } : {}) });
          pages++; boundedSignal.throwIfAborted();
          if (result.roomId !== connection.roomId || result.workItemId !== workItemId
            || JSON.stringify(identity(result)) !== JSON.stringify(identity(initial))) throw fail("context_scope_changed");
          receivedBytes += Buffer.byteLength(JSON.stringify(result));
          if (receivedBytes > maxBytes) throw fail("context_cache_limit");
          const page = result.discussion;
          delta.push(...page.items);
          if (!page.hasMore) {
            if (typeof page.resumeToken !== "string" || !page.resumeToken || !integer(page.checkpoint)) throw fail("context_cache_incomplete");
            completed = { checkpoint: page.checkpoint, resumeToken: page.resumeToken }; break;
          }
          if (page.resumeToken != null || !page.nextCursor || seen.has(page.nextCursor)) throw fail("context_cache_incomplete");
          cursor = page.nextCursor; seen.add(cursor);
        }
        if (!completed) throw fail("context_cache_limit");
        break;
      } catch (error) {
        if (error.status !== 409 || error.code !== "discussion_reset_required") throw error;
        cache.remove(); saved = null; reset = true;
        if (attempt === 1) throw error;
      }
    }
    const current = await client.workContext(workItemId, { signal: boundedSignal });
    boundedSignal.throwIfAborted();
    if (contextScope(current, connection, workItemId) !== initialScope) throw fail("context_scope_changed");
    const items = [...(saved?.items ?? []), ...delta], ids = new Set();
    for (const row of items) {
      if (!row?.message?.id || ids.has(row.message.id)) throw fail("context_cache_invalid");
      ids.add(row.message.id);
    }
    const discussion = { items, ...completed };
    cache.write(discussion);
    return { roomId: current.roomId, viewer: current.viewer, work: current.work, next: current.next, instructions: current.context?.charter ?? null,
      ...(current.replyRequestContext === undefined ? {} : { replyRequestContext: current.replyRequestContext }),
      discussion: { since: 0, ...discussion }, changedDuringRead: initial.work.revision !== current.work.revision,
      eventsAfterDiscussion: current.evaluatedThrough > completed.checkpoint,
      continuation: { reused: Boolean(saved), reset, retainedItems: saved?.items.length ?? 0, deltaItems: delta.length, pages, receivedBytes } };
  } catch (error) {
    if (["context_scope_changed", "context_cache_invalid", "identity_mismatch", "identity_credential_changed", "invalid_response"].includes(error.code)
      || [401, 403].includes(error.status)) cache.remove();
    throw error;
  }
}
