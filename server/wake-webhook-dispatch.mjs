// Signed webhook wake-ups for resident agents (Agent-Room steal 2).
//
// Polling loops (e.g. a 30s heartbeat poll) burn tokens just to ask
// "anything new?". A room wake webhook is the inverse: a participant
// registers a URL for a room, and the server POSTs a signed wake event
// whenever someone ELSE's message lands. The woken agent reads from its
// own cursor and replies like any other participant — then goes back to
// sleep. Event-driven residents instead of polling residents.
//
// Mechanics:
// - Registration is participant-gated: only a current room participant may
//   register a hook for that room (via the injected isParticipant check).
// - Cap of 5 hooks per room; upsert keyed by URL (re-registering resets the
//   failure counter).
// - Optional HMAC-SHA256 shared secret -> X-ProjectRoom-Signature:
//   sha256=<hex hmac of the raw body>. Unsigned hooks get no header.
// - SSRF posture: require https, refuse localhost / private / link-local /
//   metadata hostnames and IP literals (canonical ranges from
//   server/ip-blocklist.mjs) AT REGISTRATION; at delivery the hostname is
//   DNS-RESOLVED and EVERY answer is re-vetted, and the POST is pinned to
//   the vetted addresses (node:http/https with a pinned lookup) so a
//   record that rebinds between the check and the connection is never
//   consulted. On Cloudflare Workers there is no pinning API, so the
//   Workers egress sandbox is the backstop and plain fetch is used.
//   PROJECT_ROOM_WAKE_WEBHOOK_ALLOW_HTTP=1 relaxes the scheme check for
//   self-hosters on private networks (and tests).
// - Dispatch is never on the response critical path: the wiring layer calls
//   dispatchRoomWakes() after the message append, off-path (Cloudflare:
//   waitUntil-style; node: don't await it before responding).
// - 5s delivery timeout; a hook is dropped after 20 consecutive failures so
//   a dead endpoint stops costing a timeout on every message.
// - Self-wake suppression: a hook never fires for its sender's own messages.
// - Payload carries the absolute message cursor after the appended message,
//   so the receiver can read exactly what's new.
//
// Storage: a small room_wake_hooks table provisioned by the wiring layer
// (see docs/WEBHOOK-WAKEUPS.md "Provisioning"). The module never creates the
// table itself — createWakeWebhooks fails closed with schema-not-provisioned
// when it is absent — so the table stays out of the store's auditRecovery
// table inventory until the wiring task registers it in
// server/writer-fence.mjs unfencedAdditiveTables and execs the schema at
// store open. The db handle, clock, id generator, participant check, and
// fetch are all injected — the module does no I/O of its own.
//
// HTTP routes (POST/DELETE/GET /api/rooms/{roomId}/wake-hooks) and the
// message-append call site in server/http.mjs are DEFERRED: server/http.mjs
// and docs/openapi.yaml are held live by another lane. The deferred wiring
// task mounts createWakeWebhooks() the same way access-requests.mjs was
// mounted; see docs/WEBHOOK-WAKEUPS.md.
//
// ---------------------------------------------------------------------------
// ATTRIBUTION
// The SSRF URL validator and the dispatch/failure bookkeeping below are
// adapted from Agent Room (https://github.com/agent-room-alkl/agent-room),
// MIT License, Copyright (c) 2026 Agent Room contributors, used under the
// MIT License. The full license text:
//
// MIT License
//
// Copyright (c) 2026 Agent Room contributors
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// ---------------------------------------------------------------------------

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as dns } from "node:dns";
// Canonical SSRF ranges + pinned transport (shared with the web-fetch and
// webhook-dispatch paths so a hardening fix can never land in one and miss
// the other). node:dns is only touched by the opt-in async resolution in
// resolveWakeWebhookTarget below.
import { parseIpv4, parseIpv6, isBlockedIp, isBlockedIpv6Value, isWorkersRuntime } from "./ip-blocklist.mjs";
import { pinnedDispatchPost } from "./webhook-dispatch.mjs";

// Local ServiceError (mirrors server/store.mjs). We avoid importing from
// store.mjs here to break the circular dependency for the Workers bundle:
// store.mjs may import this module in the wiring slice, so this module
// cannot import from store.mjs at the top level.
class WakeWebhookError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "WakeWebhookError";
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => { throw new WakeWebhookError(status, code, message); };
const check = (condition, status, code, message) => { if (!condition) fail(status, code, message); };

// ---- Tunables (match the upstream values; the wiring layer may override) ----
export const MAX_WAKE_HOOKS_PER_ROOM = 5;
export const DELIVERY_TIMEOUT_MS = 5_000;
export const MAX_CONSECUTIVE_FAILURES = 20;
export const WAKE_MESSAGE_EVENT = "room.message";
export const SIGNATURE_HEADER = "x-projectroom-signature";
export const SIGNATURE_SCHEME = "sha256=";

// ---- Storage contract -------------------------------------------------------
// The module does NOT create its own table: the room_wake_hooks table is
// provisioned by the wiring layer (see docs/WEBHOOK-WAKEUPS.md "Provisioning").
// Expected shape: id TEXT PRIMARY KEY, room_id TEXT NOT NULL, url TEXT NOT
// NULL, registered_by TEXT NOT NULL, secret TEXT (nullable),
// fail_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
// with a UNIQUE(room_id, url) index and an index on room_id.
// Keeping DDL out of this module keeps the table out of the store's
// auditRecovery table inventory until the wiring task registers it.
export const WAKE_HOOKS_TABLE = "room_wake_hooks";

// ---- SSRF-hardened URL validation -------------------------------------------
// Hostname-name blocks (things that are internal by name, not by address).
// IP-literal verdicts come from the canonical server/ip-blocklist.mjs so
// every SSRF path in the repo shares one definition of "private".
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
]);

// Validate a webhook URL the same way at registration and at delivery.
// Returns the normalized href. Throws WakeWebhookError(422) on rejection.
// This is the string-level gate: IP literals are vetted against the full
// canonical blocklist (private, loopback, link-local, multicast, reserved,
// documentation, CGNAT, and IPv4 embedded in IPv6); DNS names are vetted
// again after resolution by resolveWakeWebhookTarget at delivery time.
export function validateWakeWebhookUrl(raw) {
  check(typeof raw === "string" && raw.length > 0 && raw.length <= 2000,
    422, "invalid_url", "url must be a 1-2000 char string");
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(422, "invalid_url", "Not a valid absolute URL.");
  }
  const allowHttp = process.env.PROJECT_ROOM_WAKE_WEBHOOK_ALLOW_HTTP === "1";
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    fail(422, "invalid_url", "Webhook URLs must be https.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const bare = host.replace(/^\[|\]$/g, "");
  if (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    (!allowHttp && isBlockedIp(bare))
  ) {
    fail(422, "invalid_url", "Webhook URLs must point at a public host.");
  }
  if (url.username || url.password) {
    fail(422, "invalid_url", "Webhook URLs must not embed credentials.");
  }
  return url.href;
}

// DNS-resolution + pinning companion to validateWakeWebhookUrl (H-4 fix).
// Resolves the validated URL's hostname, vets EVERY DNS answer against the
// canonical blocklist, and returns the checked addresses so the delivery
// path pins the connection to exactly those — a record that rebinds to a
// private address between the check and the POST is never consulted.
// Fails closed: a name that does not resolve, or an answer that is not a
// vetted public IP, is rejected. The resolver is injectable
// ({ resolve4, resolve6 }) so tests never touch the network.
// allowPrivate mirrors the PROJECT_ROOM_WAKE_WEBHOOK_ALLOW_HTTP self-hoster
// escape hatch: private resolved addresses pass only when it is set.
export async function resolveWakeWebhookTarget(raw, { resolve4 = dns.resolve4, resolve6 = dns.resolve6 } = {}) {
  const normalized = validateWakeWebhookUrl(raw);
  const allowPrivate = process.env.PROJECT_ROOM_WAKE_WEBHOOK_ALLOW_HTTP === "1";
  const host = new URL(normalized).hostname.toLowerCase().replace(/\.$/, "");
  const bare = host.replace(/^\[|\]$/g, "");
  // IP literals were already vetted by validateWakeWebhookUrl; the literal
  // itself is the pinned set (no second resolution to rebind).
  if (parseIpv4(bare) !== null || parseIpv6(bare) !== null) {
    return { url: normalized, addresses: [bare] };
  }
  let answers = [];
  try {
    const settled = await Promise.allSettled([resolve4(host), resolve6(host)]);
    answers = settled.flatMap(result => (result.status === "fulfilled" ? result.value : []));
  } catch { answers = []; }
  if (!allowPrivate) {
    for (const answer of answers) {
      if (parseIpv4(answer) !== null) {
        if (isBlockedIp(answer)) {
          fail(422, "invalid_url", "Webhook URL resolves to a private or reserved address.");
        }
        continue;
      }
      // Fail closed on anything unparseable — a DNS answer that is not an
      // IP literal is not something we can vet.
      const v6 = parseIpv6(answer);
      if (v6 === null || isBlockedIpv6Value(v6)) {
        fail(422, "invalid_url", "Webhook URL resolves to a private or reserved address.");
      }
    }
  }
  if (answers.length === 0 && !isWorkersRuntime()) {
    fail(422, "invalid_url", "Webhook URL hostname does not resolve to a usable address.");
  }
  return { url: normalized, addresses: answers };
}

// ---- Payload signing --------------------------------------------------------

export function signWakePayload(secret, body) {
  check(typeof secret === "string" && secret.length > 0,
    422, "invalid_secret", "secret is required to sign a payload");
  check(typeof body === "string",
    422, "invalid_body", "body must be the raw string that was delivered");
  return SIGNATURE_SCHEME + createHmac("sha256", secret).update(body).digest("hex");
}

// Timing-safe verification of an inbound wake delivery's signature header.
// Returns false (never throws) on any malformed input.
export function verifyWakeSignature(secret, signature, body) {
  if (typeof secret !== "string" || secret.length === 0) return false;
  if (typeof signature !== "string" || !signature.startsWith(SIGNATURE_SCHEME)) return false;
  if (typeof body !== "string") return false;
  const expected = Buffer.from(signWakePayload(secret, body).slice(SIGNATURE_SCHEME.length), "hex");
  const actual = Buffer.from(signature.slice(SIGNATURE_SCHEME.length), "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// ---- Store -------------------------------------------------------------------

const hookView = row => row ? Object.freeze({
  id: row.id,
  roomId: row.room_id,
  url: row.url,
  registeredBy: row.registered_by,
  // The secret never leaves this module: it is needed to sign deliveries,
  // but no view, list, or journal ever echoes it back.
  hasSecret: row.secret !== null && row.secret !== undefined,
  failCount: row.fail_count,
  createdAt: row.created_at,
}) : null;

export function createWakeWebhooks({ db, clock, id, isParticipant, fetchFn, dnsResolvers } = {}) {
  check(db && typeof db.prepare === "function",
    500, "misconfigured", "db (node:sqlite DatabaseSync) is required");
  check(typeof isParticipant === "function",
    500, "misconfigured", "isParticipant(roomId, name) is required");
  check(dnsResolvers === undefined || (dnsResolvers !== null && typeof dnsResolvers === "object"),
    500, "misconfigured", "dnsResolvers must be an object");
  const provisioned = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(WAKE_HOOKS_TABLE);
  if (!provisioned) {
    fail(500, "schema-not-provisioned",
      `${WAKE_HOOKS_TABLE} is not provisioned on this database — the wiring layer must create it (see docs/WEBHOOK-WAKEUPS.md "Provisioning").`);
  }
  const now = clock ?? Date.now;
  const newId = id ?? (() => "wh_" + randomUUID().replace(/-/g, "").slice(0, 12));
  const fetchImpl = fetchFn ?? globalThis.fetch;
  const fetchOverridden = fetchFn !== undefined && fetchFn !== null;
  const resolvers = dnsResolvers ?? {};

  const hooksForRoom = roomId =>
    db.prepare("SELECT * FROM room_wake_hooks WHERE room_id = ? ORDER BY created_at ASC").all(roomId);

  // Register (or update, keyed by URL) a wake webhook. The registrant must
  // currently be a participant of the room — wake-ups are a participant
  // feature, not an anonymous tap on someone else's conversation.
  const register = ({ roomId, url, registeredBy, secret = null }) => {
    check(typeof roomId === "string" && roomId.length > 0,
      422, "invalid_room", "roomId must be a non-empty string");
    check(typeof registeredBy === "string" && registeredBy.length > 0,
      422, "invalid_registrant", "registeredBy must be a non-empty string");
    const normalized = validateWakeWebhookUrl(url);
    if (!isParticipant(roomId, registeredBy)) {
      fail(403, "not_participant",
        `"${registeredBy}" is not a participant of this room — join it before registering a wake webhook.`);
    }
    if (secret !== null && secret !== undefined) {
      check(typeof secret === "string" && secret.length >= 16,
        422, "invalid_secret", "secret must be ≥16 chars if given");
    }
    const existing = db.prepare(
      "SELECT * FROM room_wake_hooks WHERE room_id = ? AND url = ?").get(roomId, normalized);
    if (existing) {
      db.prepare(
        "UPDATE room_wake_hooks SET registered_by = ?, secret = ?, fail_count = 0 WHERE id = ?"
      ).run(registeredBy, secret ?? null, existing.id);
      return hookView({ ...existing, registered_by: registeredBy, secret: secret ?? null, fail_count: 0 });
    }
    const hooks = hooksForRoom(roomId);
    if (hooks.length >= MAX_WAKE_HOOKS_PER_ROOM) {
      fail(409, "webhook_limit", `A room can have at most ${MAX_WAKE_HOOKS_PER_ROOM} wake webhooks.`);
    }
    const hookId = newId();
    db.prepare(
      "INSERT INTO room_wake_hooks (id, room_id, url, registered_by, secret, fail_count, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)"
    ).run(hookId, roomId, normalized, registeredBy, secret ?? null, now());
    return hookView(db.prepare("SELECT * FROM room_wake_hooks WHERE id = ?").get(hookId));
  };

  // Remove by id or exact URL. Only the registrant may remove their hook.
  const unregister = ({ roomId, idOrUrl, registeredBy }) => {
    check(typeof roomId === "string" && roomId.length > 0,
      422, "invalid_room", "roomId must be a non-empty string");
    const row = db.prepare(
      "SELECT * FROM room_wake_hooks WHERE room_id = ? AND (id = ? OR url = ?)").get(roomId, idOrUrl, idOrUrl);
    if (!row) return false;
    check(row.registered_by === registeredBy,
      403, "access_denied", "only the registrant may remove this wake webhook");
    db.prepare("DELETE FROM room_wake_hooks WHERE id = ?").run(row.id);
    return true;
  };

  const list = ({ roomId }) => {
    check(typeof roomId === "string" && roomId.length > 0,
      422, "invalid_room", "roomId must be a non-empty string");
    return Object.freeze(hooksForRoom(roomId).map(hookView));
  };

  const buildPayload = ({ roomId, message, cursor }) => {
    const body = {
      event: WAKE_MESSAGE_EVENT,
      roomId,
      message: {
        id: message.id,
        senderName: message.senderName,
        senderClient: message.senderClient ?? null,
        role: message.role ?? "agent",
        text: message.text,
        time: message.time,
      },
    };
    if (cursor !== null && cursor !== undefined) body.cursor = cursor;
    return JSON.stringify(body);
  };

  const deliverOne = async (hookRow, body, roomId) => {
    // Re-validate at delivery time (upstream rule): a URL that was valid at
    // registration may have been re-pointed at a private host since. Then
    // resolve DNS and vet every answer (H-4): a name that rebinds to an
    // internal address between the check and the POST is refused here.
    let target;
    try {
      target = await resolveWakeWebhookTarget(hookRow.url, resolvers);
    } catch {
      return false;
    }
    const headers = {
      "content-type": "application/json",
      "user-agent": "project-room-wake-webhook/1",
      "x-projectroom-event": WAKE_MESSAGE_EVENT,
      "x-projectroom-room": roomId,
      "x-projectroom-webhook-id": hookRow.id,
    };
    if (hookRow.secret) {
      headers[SIGNATURE_HEADER] = signWakePayload(hookRow.secret, body);
    }
    try {
      // Injected fetch (tests) and Workers (no pinning API; the egress
      // sandbox is the backstop) use plain fetch against the validated URL.
      // On Node the connection is pinned to the DNS answers the check
      // vetted, so a rebinding record is never consulted.
      if (fetchOverridden || isWorkersRuntime()) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
        try {
          const resp = await fetchImpl(target.url, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
            redirect: "error",
          });
          return resp != null && resp.ok === true;
        } finally {
          clearTimeout(timer);
        }
      }
      const { status } = await pinnedDispatchPost(target.url, target.addresses, {
        headers, body, timeoutMs: DELIVERY_TIMEOUT_MS,
      });
      return status >= 200 && status < 300;
    } catch {
      return false;
    }
  };

  // Fire the room's wake webhooks for one appended message. Hooks registered
  // by the sender are skipped (the sender doesn't need waking for its own
  // words). Called off the response critical path; failure bookkeeping is
  // best-effort: hooks that keep failing are dropped so they stop costing a
  // 5s timeout on every message.
  //
  // message: { id, senderName, senderClient?, role?, text, time }.
  // cursor: the absolute message cursor after this message (opaque to this
  // module; the wiring layer passes whatever the append path returns).
  const dispatchRoomWakes = async ({ roomId, message, cursor = null }) => {
    check(typeof roomId === "string" && roomId.length > 0,
      422, "invalid_room", "roomId must be a non-empty string");
    check(message && typeof message.senderName === "string" && message.senderName.length > 0,
      422, "invalid_message", "message.senderName is required");
    const hooks = hooksForRoom(roomId);
    const targets = hooks.filter(h => h.registered_by !== message.senderName);
    if (targets.length === 0) return Object.freeze([]);
    const body = buildPayload({ roomId, message, cursor });

    const results = await Promise.all(targets.map(h => deliverOne(h, body, roomId)));

    // Failure bookkeeping: hooks that keep failing are dropped so they stop
    // costing a 5s timeout on every message. Writes happen per hook (a room
    // holds at most 5), so no batching is needed.
    const outcomes = [];
    for (let i = 0; i < targets.length; i++) {
      const hook = targets[i];
      const ok = results[i];
      if (ok) {
        if (hook.fail_count > 0) {
          db.prepare("UPDATE room_wake_hooks SET fail_count = 0 WHERE id = ?").run(hook.id);
        }
        outcomes.push(Object.freeze({ hookId: hook.id, url: hook.url, outcome: "delivered" }));
      } else {
        const failCount = (hook.fail_count ?? 0) + 1;
        if (failCount >= MAX_CONSECUTIVE_FAILURES) {
          db.prepare("DELETE FROM room_wake_hooks WHERE id = ?").run(hook.id);
          outcomes.push(Object.freeze({ hookId: hook.id, url: hook.url, outcome: "dropped", failCount }));
        } else {
          db.prepare("UPDATE room_wake_hooks SET fail_count = ? WHERE id = ?").run(failCount, hook.id);
          outcomes.push(Object.freeze({ hookId: hook.id, url: hook.url, outcome: "failed", failCount }));
        }
      }
    }
    return Object.freeze(outcomes);
  };

  return Object.freeze({ register, unregister, list, dispatchRoomWakes });
}

export { WakeWebhookError };
