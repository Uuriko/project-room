// client/request-journal.mjs
//
// RequestJournal: crash-safe persist-before-send for mutating room calls.
//
// PHOENIX showed the client half of idempotency: 0% duplicate side effects
// when the worker persists its requestId BEFORE sending, 100% without. The
// server half (dedupe store) is separate; this module is the client helper
// every agent worker uses so "persist before send" is the default, not a
// discipline.
//
// Example:
//
//   import { RequestJournal } from "./client/request-journal.mjs";
//
//   // post is the injected transport: (route, payload) => parsed JSON body
//   // on 2xx, rejects on transport/HTTP errors. Never hardcoded network.
//   const post = async (route, payload) => {
//     const res = await fetch("https://room.trydemigod.com" + route, {
//       method: "POST",
//       headers: { "content-type": "application/json" },
//       body: JSON.stringify(payload),
//     });
//     if (!res.ok) throw new Error(`POST ${route}: ${res.status}`);
//     return res.json();
//   };
//   const journal = new RequestJournal("~/.config/my-agent/requests", { post });
//
//   // begin() generates the id and ATOMICALLY persists it BEFORE any network.
//   const req = journal.begin({ route: "/work-claims", body: { task: "sweep-1" } });
//   const out = await req.send(); // POSTs body + { requestId: req.id }
//   if (out.duplicate) console.log("already done:", out.result);
//
//   // On crash between begin() and send(), the entry stays 'pending'.
//   // A later process retries safely because the server dedupes by requestId:
//   for (const pending of journal.recover()) {
//     const retry = journal.begin({ route: pending.route, body: pending.body });
//     await retry.send();
//   }
//
// Atomicity: every journal write goes to a temp file (O_EXCL), is fsync'd,
// then rename()'d into place, with a directory fsync after. A crash can
// leave a leftover temp file — recover() ignores those, so an entry is
// always complete JSON or absent, never partial/corrupt.

import { randomUUID } from "node:crypto";
import {
  mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync,
  readdirSync, readFileSync, unlinkSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";

export function newRequestId() {
  return randomUUID();
}

function syncDirectory(path) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// Atomic JSON write: temp (exclusive) + fsync + rename + directory fsync.
// The temp name is never a recover() candidate, so a torn write can only
// ever surface as a leftover temp file, never as a partial entry.
function atomicWriteJson(path, value) {
  const temp = `${path}.tmp-${randomUUID()}`;
  let fd;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    syncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export class RequestJournal {
  // dir: journal directory, e.g. ~/.config/<agent>/requests.
  // opts.post: optional transport (route, payload) => parsed-JSON-promise,
  //   used as the default for begin()'s send() when no post is passed there.
  constructor(dir, opts = {}) {
    this.dir = resolve(dir);
    this.defaultPost = opts.post;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    syncDirectory(dirname(this.dir));
  }

  entryPath(id) {
    return join(this.dir, `${id}.json`);
  }

  // Generates a UUID and atomically writes {id, route, body, state:'pending'}.
  // Returns { id, send(post?) } — the id exists BEFORE any network call.
  // The id is sent in the POST body as `requestId`.
  begin({ route, body }) {
    if (typeof route !== "string" || route.length === 0) {
      throw new Error("RequestJournal.begin requires a route");
    }
    const id = newRequestId();
    atomicWriteJson(this.entryPath(id), { id, route, body, state: "pending" });
    const journal = this;
    return {
      id,
      // POSTs { ...body, requestId: id } via the injected transport.
      //  - 200 with duplicate:true → { duplicate:true, result } (not an error)
      //  - 200 otherwise           → { duplicate:false, result }
      //  - transport rejection     → entry stays 'pending', error rethrown
      async send(post = journal.defaultPost) {
        if (typeof post !== "function") {
          throw new Error("RequestJournal.send requires a post transport (pass one or set it on the journal)");
        }
        const payload = { ...body, requestId: id };
        const response = await post(route, payload); // rejects → stays pending
        const duplicate = response != null && response.duplicate === true;
        journal.markDone(id);
        // `result` is always the usable payload: the server's prior result
        // on duplicate, the response envelope's payload (when present), or
        // the raw body otherwise.
        const result = response != null && "result" in response ? response.result : response;
        return { duplicate, result };
      },
    };
  }

  // Marks an entry done atomically: the rename removes it from recover().
  markDone(id) {
    try {
      renameSync(this.entryPath(id), join(this.dir, `${id}.done.json`));
      syncDirectory(this.dir);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  // Lists 'pending' entries as [{ id, route, body }] for retry after a crash.
  // Retrying is safe because the server dedupes on requestId.
  // Leftover temp files and corrupt entries are skipped, never returned.
  recover() {
    const pending = [];
    let names;
    try { names = readdirSync(this.dir); } catch (error) {
      if (error.code === "ENOENT") return pending;
      throw error;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".json") || name.endsWith(".done.json")) continue;
      if (name.includes(".tmp-")) continue; // leftover torn write
      const id = name.slice(0, -".json".length);
      let record;
      try {
        record = JSON.parse(readFileSync(join(this.dir, name), "utf8"));
      } catch {
        continue; // corrupt entry: absent, never returned
      }
      if (!record || record.id !== id || record.state !== "pending") continue;
      pending.push({ id: record.id, route: record.route, body: record.body });
    }
    return pending;
  }
}

