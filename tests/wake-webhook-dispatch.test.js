// Signed webhook wake-ups (RC-2026-09-30-3613).
//
// Authoring gate (per .agents/skills/test-audit/SKILL.md):
// 1. Each test guards an independent, behavior-level contract of the new
//    module: SSRF validation at registration AND delivery, HMAC signature
//    verifiability, the participant gate, the per-room cap, self-wake
//    suppression, and the failure/drop bookkeeping. All are security or
//    protocol contracts with credible regressions (weakened SSRF check,
//    unsigned or mis-signed deliveries, non-participants registering hooks,
//    dead endpoints timing out every message forever).
// 2. No existing coverage: server/wake-webhook-dispatch.mjs is new; the
//    repo-wide writer-fence-unfenced test already guards table registration,
//    so this file does not re-assert it.
// 3. The fake fetch is strict per the checkout AGENTS.md: it validates the
//    delivery call shape (POST, headers, body, signal, redirect) and throws
//    on anything else instead of accepting unknown calls.
// 4. No test-only production seams: db/clock/id/isParticipant/fetchFn are
//    the wiring layer's injection points, needed by production too.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createWakeWebhooks,
  validateWakeWebhookUrl,
  resolveWakeWebhookTarget,
  signWakePayload,
  verifyWakeSignature,
  WakeWebhookError,
  WAKE_HOOKS_TABLE,
  MAX_WAKE_HOOKS_PER_ROOM,
  MAX_CONSECUTIVE_FAILURES,
  SIGNATURE_HEADER,
} from "../server/wake-webhook-dispatch.mjs";

const T0 = 1_750_000_000_000;
const PUBLIC = "https://hooks.example.com/wake";
const PUBLIC2 = "https://hooks.example.org/wake";
// The fake DNS answers below never leave the test process (fetch is faked
// too); they just need to be public-range literals for the vetting step.
const PUBLIC_IP = "93.184.216.34";

// Strict fake fetch: validates the delivery call shape and throws on
// anything unexpected (per checkout AGENTS.md — no permissive doubles).
function strictFetch(handler) {
  return async (url, init = {}) => {
    assert.equal(typeof url, "string", "fetch url must be a string");
    assert.equal(init.method, "POST", "delivery must be POST");
    assert.equal(init.redirect, "error", "delivery must not follow redirects");
    assert.equal(typeof init.body, "string", "delivery body must be a string");
    assert.equal(init.headers["content-type"], "application/json");
    assert.equal(init.headers["user-agent"], "project-room-wake-webhook/1");
    assert.ok(init.signal instanceof AbortSignal, "delivery must carry an abort signal");
    assert.equal(typeof init.headers["x-projectroom-event"], "string");
    assert.equal(typeof init.headers["x-projectroom-room"], "string");
    assert.equal(typeof init.headers["x-projectroom-webhook-id"], "string");
    return handler(url, init);
  };
}

test("createWakeWebhooks refuses a database without the provisioned table", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  assert.throws(
    () => createWakeWebhooks({ db, isParticipant: () => true }),
    err => err instanceof WakeWebhookError
      && err.code === "schema-not-provisioned"
      && err.message.includes(WAKE_HOOKS_TABLE),
    "must fail closed naming the missing table instead of 'no such table'",
  );
});

function setup(t, { participants = ["alice", "bob"], fetchFn, dnsResolvers } = {}) {
  const db = new DatabaseSync(":memory:");
  // Test-only DDL: the wiring layer provisions this table in the app DB
  // (see docs/WEBHOOK-WAKEUPS.md "Provisioning"). The module itself never
  // creates it, so the table stays out of the store's auditRecovery
  // inventory until the wiring task registers it.
  db.exec(`
    CREATE TABLE room_wake_hooks (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      url TEXT NOT NULL,
      registered_by TEXT NOT NULL,
      secret TEXT,
      fail_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX room_wake_hooks_room ON room_wake_hooks(room_id);
    CREATE UNIQUE INDEX room_wake_hooks_room_url ON room_wake_hooks(room_id, url);
  `);
  const hooks = createWakeWebhooks({
    db,
    clock: () => T0,
    id: (() => { let n = 0; return () => `wh_test${++n}`; })(),
    isParticipant: (roomId, name) => roomId === "room-1" && participants.includes(name),
    fetchFn: fetchFn ?? strictFetch(async () => ({ ok: true })),
    // Delivery resolves DNS before connecting (H-4); the fake resolver
    // answers a public IP for the example hosts so tests never touch the
    // network. Attacker-DNS cases below override it per test.
    dnsResolvers: dnsResolvers ?? {
      resolve4: async host => (host === "hooks.example.com" || host === "hooks.example.org" ? [PUBLIC_IP] : []),
      resolve6: async () => [],
    },
  });
  t.after(() => db.close());
  return { db, hooks };
}

const messageFrom = senderName => ({
  id: "msg-1",
  senderName,
  senderClient: "test-client",
  role: "agent",
  text: "hello room",
  time: T0,
});

// ---- SSRF validation: registration gate ----

test("SSRF validator accepts public https URLs and rejects private/internal targets", () => {
  assert.equal(validateWakeWebhookUrl("https://hooks.example.com/wake/x"), "https://hooks.example.com/wake/x");
  const blocked = [
    "http://hooks.example.com/wake",           // plain http rejected by default
    "https://localhost/wake",
    "https://127.0.0.1/wake",
    "https://10.0.0.5/wake",
    "https://192.168.1.1/wake",
    "https://172.16.0.1/wake",
    "https://169.254.169.254/latest",          // cloud metadata
    "https://metadata.google.internal/wake",
    "https://svc.internal/wake",
    "https://svc.local/wake",
    "https://[::1]/wake",
    "https://user:pass@hooks.example.com/wake", // embedded credentials
    "not a url",
    "",
  ];
  for (const raw of blocked) {
    assert.throws(() => validateWakeWebhookUrl(raw), WakeWebhookError, `should reject: ${raw}`);
  }
});

test("registration rejects SSRF-blocked URLs with a 422", t => {
  const { hooks } = setup(t);
  assert.throws(
    () => hooks.register({ roomId: "room-1", url: "https://127.0.0.1/wake", registeredBy: "alice" }),
    err => err instanceof WakeWebhookError && err.status === 422 && err.code === "invalid_url");
});

test("PROJECT_ROOM_WAKE_WEBHOOK_ALLOW_HTTP=1 permits http for self-hosters", t => {
  const prev = process.env.PROJECT_ROOM_WAKE_WEBHOOK_ALLOW_HTTP;
  process.env.PROJECT_ROOM_WAKE_WEBHOOK_ALLOW_HTTP = "1";
  t.after(() => {
    if (prev === undefined) delete process.env.PROJECT_ROOM_WAKE_WEBHOOK_ALLOW_HTTP;
    else process.env.PROJECT_ROOM_WAKE_WEBHOOK_ALLOW_HTTP = prev;
  });
  const { hooks } = setup(t);
  const view = hooks.register({ roomId: "room-1", url: "http://10.0.0.9/wake", registeredBy: "alice" });
  assert.equal(view.url, "http://10.0.0.9/wake");
});

// ---- Registration: participant gate, cap, upsert ----

test("non-participants cannot register a wake webhook (403)", t => {
  const { hooks } = setup(t);
  assert.throws(
    () => hooks.register({ roomId: "room-1", url: PUBLIC, registeredBy: "mallory" }),
    err => err instanceof WakeWebhookError && err.status === 403 && err.code === "not_participant");
});

test("per-room cap of 5 is enforced; re-registering the same URL upserts", t => {
  const { hooks } = setup(t);
  for (let i = 0; i < MAX_WAKE_HOOKS_PER_ROOM; i++) {
    hooks.register({ roomId: "room-1", url: `https://hooks.example.com/wake-${i}`, registeredBy: "alice" });
  }
  assert.throws(
    () => hooks.register({ roomId: "room-1", url: "https://hooks.example.com/sixth", registeredBy: "alice" }),
    err => err instanceof WakeWebhookError && err.status === 409 && err.code === "webhook_limit");
  // Upsert by URL: resets the failure counter instead of counting as a new hook.
  const first = hooks.list({ roomId: "room-1" })[0];
  assert.equal(hooks.list({ roomId: "room-1" }).length, MAX_WAKE_HOOKS_PER_ROOM);
  const again = hooks.register({ roomId: "room-1", url: first.url, registeredBy: "alice" });
  assert.equal(again.id, first.id);
  assert.equal(hooks.list({ roomId: "room-1" }).length, MAX_WAKE_HOOKS_PER_ROOM);
});

test("registered views never echo the signing secret", t => {
  const { hooks } = setup(t);
  const view = hooks.register({
    roomId: "room-1", url: PUBLIC, registeredBy: "alice", secret: "sixteen-char-secret",
  });
  assert.equal(view.hasSecret, true);
  assert.ok(!("secret" in view), "view must not carry the secret");
  for (const listed of hooks.list({ roomId: "room-1" })) {
    assert.ok(!("secret" in listed), "list must not carry secrets");
  }
});

// ---- HMAC signing ----

test("signed deliveries verify; tampered bodies and secrets fail", t => {
  const secret = "sixteen-char-secret";
  let seen;
  const { hooks } = setup(t, {
    fetchFn: strictFetch(async (url, init) => { seen = init; return { ok: true }; }),
  });
  hooks.register({ roomId: "room-1", url: PUBLIC, registeredBy: "alice", secret });
  return hooks.dispatchRoomWakes({ roomId: "room-1", message: messageFrom("bob"), cursor: 42 })
    .then(outcomes => {
      assert.deepEqual(outcomes.map(o => o.outcome), ["delivered"]);
      const sig = seen.headers[SIGNATURE_HEADER];
      assert.ok(sig.startsWith("sha256="), "signature header uses sha256= scheme");
      assert.equal(sig, signWakePayload(secret, seen.body), "header matches the signing function exactly");
      assert.equal(verifyWakeSignature(secret, sig, seen.body), true);
      assert.equal(verifyWakeSignature(secret, sig, seen.body + "x"), false);
      assert.equal(verifyWakeSignature("wrong-secret-16ch", sig, seen.body), false);
      assert.equal(verifyWakeSignature(secret, "sha256=deadbeef", seen.body), false);
      // Cursor is the money field: the receiver reads only what's new.
      assert.equal(JSON.parse(seen.body).cursor, 42);
    });
});

test("unsigned hooks carry no signature header", t => {
  let seen;
  const { hooks } = setup(t, {
    fetchFn: strictFetch(async (url, init) => { seen = init; return { ok: true }; }),
  });
  hooks.register({ roomId: "room-1", url: PUBLIC, registeredBy: "alice" });
  return hooks.dispatchRoomWakes({ roomId: "room-1", message: messageFrom("bob") }).then(() => {
    assert.ok(!(SIGNATURE_HEADER in seen.headers), "unsigned hook must not get a signature header");
  });
});

// ---- Dispatch semantics ----

test("self-wake suppression: a hook never fires for its sender's own messages", t => {
  const calls = [];
  const { hooks } = setup(t, {
    fetchFn: strictFetch(async (url, init) => { calls.push({ url, body: init.body }); return { ok: true }; }),
  });
  hooks.register({ roomId: "room-1", url: PUBLIC, registeredBy: "alice", secret: "sixteen-char-secret" });
  hooks.register({ roomId: "room-1", url: PUBLIC2, registeredBy: "bob", secret: "sixteen-char-secret" });
  return hooks.dispatchRoomWakes({ roomId: "room-1", message: messageFrom("alice"), cursor: 7 })
    .then(outcomes => {
      assert.equal(calls.length, 1, "only bob's hook fires for alice's message");
      assert.equal(calls[0].url, PUBLIC2);
      const payload = JSON.parse(calls[0].body);
      assert.equal(payload.event, "room.message");
      assert.equal(payload.roomId, "room-1");
      assert.equal(payload.message.senderName, "alice");
    });
});

test("delivery re-validates the URL: a hook re-pointed at a private host is blocked", t => {
  const calls = [];
  const { db, hooks } = setup(t, {
    fetchFn: strictFetch(async (url, init) => { calls.push(url); return { ok: true }; }),
  });
  const view = hooks.register({ roomId: "room-1", url: PUBLIC, registeredBy: "alice" });
  // Re-point the stored URL at an internal host (TOCTOU between registration
  // and delivery); delivery must refuse, not POST to it.
  db.prepare("UPDATE room_wake_hooks SET url = ? WHERE id = ?").run("https://10.1.2.3/wake", view.id);
  return hooks.dispatchRoomWakes({ roomId: "room-1", message: messageFrom("bob") }).then(outcomes => {
    assert.equal(calls.length, 0, "no POST to the re-pointed private host");
    assert.deepEqual(outcomes.map(o => o.outcome), ["failed"]);
  });
});

// ---- H-4: DNS resolution + transport pinning at delivery ----

test("delivery refuses a hostname that resolves to a private address (DNS rebinding)", t => {
  const calls = [];
  const { hooks } = setup(t, {
    fetchFn: strictFetch(async (url, init) => { calls.push(url); return { ok: true }; }),
    dnsResolvers: {
      // Attacker-controlled name; the resolver now answers internal.
      resolve4: async () => ["10.9.9.9"],
      resolve6: async () => [],
    },
  });
  hooks.register({ roomId: "room-1", url: PUBLIC, registeredBy: "alice" });
  return hooks.dispatchRoomWakes({ roomId: "room-1", message: messageFrom("bob") }).then(outcomes => {
    assert.equal(calls.length, 0, "no POST to a host that resolves private");
    assert.deepEqual(outcomes.map(o => o.outcome), ["failed"]);
  });
});

test("delivery refuses mixed answers when any resolved address is private", t => {
  const calls = [];
  const { hooks } = setup(t, {
    fetchFn: strictFetch(async (url, init) => { calls.push(url); return { ok: true }; }),
    dnsResolvers: {
      resolve4: async () => [PUBLIC_IP, "192.168.1.7"],
      resolve6: async () => [],
    },
  });
  hooks.register({ roomId: "room-1", url: PUBLIC, registeredBy: "alice" });
  return hooks.dispatchRoomWakes({ roomId: "room-1", message: messageFrom("bob") }).then(outcomes => {
    assert.equal(calls.length, 0, "one private answer poisons the whole set");
    assert.deepEqual(outcomes.map(o => o.outcome), ["failed"]);
  });
});

test("delivery fails closed when the hostname does not resolve", t => {
  const calls = [];
  const { hooks } = setup(t, {
    fetchFn: strictFetch(async (url, init) => { calls.push(url); return { ok: true }; }),
    dnsResolvers: { resolve4: async () => [], resolve6: async () => [] },
  });
  hooks.register({ roomId: "room-1", url: PUBLIC, registeredBy: "alice" });
  return hooks.dispatchRoomWakes({ roomId: "room-1", message: messageFrom("bob") }).then(outcomes => {
    assert.equal(calls.length, 0, "no POST when DNS has no vetted answer");
    assert.deepEqual(outcomes.map(o => o.outcome), ["failed"]);
  });
});

test("ALLOW_HTTP self-hoster escape still permits private resolved addresses", t => {
  const prev = process.env.PROJECT_ROOM_WAKE_WEBHOOK_ALLOW_HTTP;
  process.env.PROJECT_ROOM_WAKE_WEBHOOK_ALLOW_HTTP = "1";
  const calls = [];
  const { hooks } = setup(t, {
    fetchFn: strictFetch(async (url, init) => { calls.push(url); return { ok: true }; }),
    dnsResolvers: { resolve4: async () => ["10.0.0.9"], resolve6: async () => [] },
  });
  t.after(() => {
    if (prev === undefined) delete process.env.PROJECT_ROOM_WAKE_WEBHOOK_ALLOW_HTTP;
    else process.env.PROJECT_ROOM_WAKE_WEBHOOK_ALLOW_HTTP = prev;
  });
  hooks.register({ roomId: "room-1", url: "http://intranet.example/wake", registeredBy: "alice" });
  return hooks.dispatchRoomWakes({ roomId: "room-1", message: messageFrom("bob") }).then(outcomes => {
    assert.equal(calls.length, 1, "self-hoster escape hatch still delivers");
    assert.deepEqual(outcomes.map(o => o.outcome), ["delivered"]);
  });
});

test("resolveWakeWebhookTarget returns vetted addresses; rejects private answers", async () => {
  const good = await resolveWakeWebhookTarget(PUBLIC, {
    resolve4: async () => [PUBLIC_IP], resolve6: async () => [],
  });
  assert.deepEqual(good.addresses, [PUBLIC_IP]);
  // IP literals pass through as their own pinned set.
  const literal = await resolveWakeWebhookTarget("https://93.184.216.34/wake", {
    resolve4: async () => { throw new Error("must not resolve literals"); },
    resolve6: async () => { throw new Error("must not resolve literals"); },
  });
  assert.deepEqual(literal.addresses, ["93.184.216.34"]);
  // IPv6 literal in a blocked range is rejected by the string gate.
  await assert.rejects(
    resolveWakeWebhookTarget("https://[::1]/wake", { resolve4: async () => [], resolve6: async () => [] }),
    err => err instanceof WakeWebhookError && err.code === "invalid_url");
  // Private DNS answers are rejected.
  await assert.rejects(
    resolveWakeWebhookTarget(PUBLIC, { resolve4: async () => ["169.254.169.254"], resolve6: async () => [] }),
    err => err instanceof WakeWebhookError && err.code === "invalid_url");
  // Unresolvable names fail closed.
  await assert.rejects(
    resolveWakeWebhookTarget(PUBLIC, { resolve4: async () => [], resolve6: async () => [] }),
    err => err instanceof WakeWebhookError && err.code === "invalid_url");
});

test("consecutive failures drop the hook after 20; success resets the counter", t => {
  let fail = true;
  const { db, hooks } = setup(t, {
    fetchFn: strictFetch(async () => ({ ok: !fail })),
  });
  const view = hooks.register({ roomId: "room-1", url: PUBLIC, registeredBy: "alice" });
  const dispatch = () => hooks.dispatchRoomWakes({ roomId: "room-1", message: messageFrom("bob") });
  let chain = Promise.resolve();
  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) chain = chain.then(dispatch);
  return chain.then(() => {
    const row = db.prepare("SELECT fail_count FROM room_wake_hooks WHERE id = ?").get(view.id);
    assert.equal(row.fail_count, MAX_CONSECUTIVE_FAILURES - 1);
    assert.equal(hooks.list({ roomId: "room-1" }).length, 1, "still registered before the limit");
  }).then(dispatch).then(outcomes => {
    assert.deepEqual(outcomes.map(o => o.outcome), ["dropped"]);
    assert.equal(hooks.list({ roomId: "room-1" }).length, 0, "dropped after 20 consecutive failures");
  }).then(() => {
    // Success resets fail_count.
    fail = false;
    const v2 = hooks.register({ roomId: "room-1", url: PUBLIC, registeredBy: "alice" });
    db.prepare("UPDATE room_wake_hooks SET fail_count = 5 WHERE id = ?").run(v2.id);
    return dispatch().then(outcomes => {
      assert.deepEqual(outcomes.map(o => o.outcome), ["delivered"]);
      const row = db.prepare("SELECT fail_count FROM room_wake_hooks WHERE id = ?").get(v2.id);
      assert.equal(row.fail_count, 0);
    });
  });
});

// ---- Unregister ----

test("unregister by id or URL; only the registrant may remove", t => {
  const { hooks } = setup(t);
  const view = hooks.register({ roomId: "room-1", url: PUBLIC, registeredBy: "alice" });
  assert.throws(
    () => hooks.unregister({ roomId: "room-1", idOrUrl: view.id, registeredBy: "bob" }),
    err => err instanceof WakeWebhookError && err.status === 403);
  assert.equal(hooks.unregister({ roomId: "room-1", idOrUrl: view.id, registeredBy: "alice" }), true);
  assert.equal(hooks.unregister({ roomId: "room-1", idOrUrl: view.id, registeredBy: "alice" }), false);
  hooks.register({ roomId: "room-1", url: PUBLIC2, registeredBy: "alice" });
  assert.equal(hooks.unregister({ roomId: "room-1", idOrUrl: PUBLIC2, registeredBy: "alice" }), true);
  assert.equal(hooks.list({ roomId: "room-1" }).length, 0);
});
