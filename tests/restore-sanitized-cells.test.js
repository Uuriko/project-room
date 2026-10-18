// #3599: NDJSON export→restore must not load sha256 placeholders as live
// values. The export sanitizes exactly the EXPORT_SECRET_COLUMNS set; a
// restore substitutes every sanitized cell (NULL, or "" where NOT NULL),
// counts it in the result's sanitizedCells, and round-trips everything
// else — including the two columns the pre-#3599 name-regex exporter
// over-hashed (accounts.password_reset_required, bounty_records.verifier).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccountLoginMethods } from "../server/account-login-methods.mjs";
import { exportNdjsonText, replayNdjson } from "../server/room-export.mjs";
import { replayNdjsonInto, createBackupReplaySession } from "../server/restore-ndjson.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const VERIFIER_LANE = "verifier-lane";
const SECRETS = {
  pkce: "pkce-verifier-value", pushToken: "agent-push-token-value", hook: "webhook-secret-value",
  cipher: "gmail-ciphertext-value", p256dh: "p256dh-key-value", pushAuth: "push-auth-value",
  slot: "oauth-slot-token-value", oauthVerifier: "oauth-verifier-value", join: "room-join-token-value",
  seed: "referral-private-seed-value"
};
// Every sanitized cell the seed below plants: one per EXPORT_SECRET_COLUMNS
// entry, so a restore's report must equal this map exactly.
const EXPECTED_SANITIZED = {
  account_login_methods: { verifier: 1 },
  agent_push_configs: { push_token: 1 },
  agent_webhook_subs: { secret: 1 },
  gmail_linked_mailboxes: { encrypted: 1 },
  gmail_mailboxes: { encrypted: 1 },
  gmail_pending: { encrypted: 1 },
  human_push_subscriptions: { auth: 1, p256dh: 1 },
  oauth_pending_states: { slot_token: 1, verifier: 1 },
  public_rooms: { join_token: 1 },
  referral_invite_keys: { private_seed: 1 }
};

function seed(t, { flag = 1 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "restore-sanitized-"));
  const store = new RoomStore(join(directory, "live.sqlite"));
  t.after(() => { try { store.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  store.issueAccessKey("commons", "owner");
  const account = store.db.prepare("SELECT id FROM accounts").get();
  store.transaction(() => {
    store.db.prepare("UPDATE accounts SET password_reset_required=? WHERE id=?").run(flag, account.id);
    store.db.prepare(`INSERT INTO bounty_records
      (bounty_id, room_id, title, criteria, amount_millis, poster, verifier, approval_mode, state, state_changed_ms, deadline_ms, created_at, updated_at)
      VALUES ('b-3599', 'commons', 'Seeded bounty', 'Pass the round trip', 1000, 'owner', ?, 'agent', 'open', 1, 9999999999999, '2026-01-01', '2026-01-01')`).run(VERIFIER_LANE);
    store.db.prepare(`INSERT INTO human_push_subscriptions
      (endpoint, room_id, member_id, p256dh, auth, expiration_time, created_at)
      VALUES ('https://push.example/x', 'commons', 'owner', ?, ?, NULL, 1)`).run(SECRETS.p256dh, SECRETS.pushAuth);
    store.db.prepare(`INSERT INTO agent_webhook_subs
      (subscription_id, agent_id, url, events_json, secret, enabled, created_at)
      VALUES ('sub-3599', 'agent-1', 'https://example.com/hook', '[]', ?, 1, 1)`).run(SECRETS.hook);
    store.db.prepare(`INSERT INTO public_rooms
      (slug, title, purpose, humans, agents, names_json, tasks_json, members_json, receipts_enabled, join_mode, join_token, updated_at)
      VALUES ('commons-public', 'Commons', 'Seeded', 1, 1, '[]', '[]', '[]', 1, 'token', ?, '2026-01-01')`).run(SECRETS.join);
    store.db.prepare(`INSERT INTO account_login_methods (id, account_id, type, label, verifier, created_at)
      VALUES ('lm-3599', ?, 'oauth', 'Google', ?, 1)`).run(account.id, SECRETS.pkce);
    store.db.prepare(`INSERT INTO agent_push_configs (agent_id, host_id, push_token, updated_at)
      VALUES ('agent-1', 'host-1', ?, 1)`).run(SECRETS.pushToken);
    store.db.prepare("INSERT INTO gmail_mailboxes (account_id, auth_epoch, encrypted) VALUES (?, 1, ?)").run(account.id, SECRETS.cipher);
    store.db.prepare("INSERT INTO gmail_linked_mailboxes (account_id, mailbox_id, auth_epoch, encrypted) VALUES (?, 'mb-1', 1, ?)").run(account.id, SECRETS.cipher);
    store.db.prepare("INSERT INTO gmail_pending (state_hash, account_id, expires_at, encrypted) VALUES (?, ?, 9999999999999, ?)").run("cd".repeat(32), account.id, SECRETS.cipher);
    store.db.prepare(`INSERT INTO oauth_pending_states
      (state_hash, provider, slot_token, expected_revision, verifier, expires_at, link, used, created_at)
      VALUES (?, 'google', ?, 0, ?, 9999999999999, 0, 0, 1)`).run("ef".repeat(32), SECRETS.slot, SECRETS.oauthVerifier);
    store.db.prepare("INSERT INTO referral_invite_keys (room_id, public_key, private_seed, created_at) VALUES ('commons', 'public-key', ?, 1)").run(SECRETS.seed);
  });
  return { directory, store, accountId: account.id };
}

function emptyTarget(t) {
  const directory = mkdtempSync(join(tmpdir(), "restore-sanitized-target-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { try { store.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function assertIdentity(db, accountId) {
  // The fuzzer's minimal repro: the flag survives as the integer 1 and its
  // consumer still reports the reset as required.
  const cell = db.prepare("SELECT password_reset_required AS v, typeof(password_reset_required) AS t FROM accounts WHERE id=?").get(accountId);
  assert.equal(cell.v, 1);
  assert.equal(cell.t, "integer");
  // Verifier authority survives verbatim: the lane can still approve.
  assert.equal(db.prepare("SELECT verifier FROM bounty_records WHERE bounty_id='b-3599'").get().verifier, VERIFIER_LANE);
}

function assertSubstitutes(db) {
  const one = (sql) => db.prepare(sql).get().v;
  // Nullable secret columns land as NULL; NOT NULL ones as "".
  assert.equal(one("SELECT verifier AS v FROM account_login_methods WHERE id='lm-3599'"), null);
  assert.equal(one("SELECT push_token AS v FROM agent_push_configs WHERE agent_id='agent-1'"), null);
  assert.equal(one("SELECT join_token AS v FROM public_rooms WHERE slug='commons-public'"), null);
  assert.equal(one("SELECT secret AS v FROM agent_webhook_subs WHERE subscription_id='sub-3599'"), "");
  assert.equal(one("SELECT p256dh AS v FROM human_push_subscriptions"), "");
  assert.equal(one("SELECT auth AS v FROM human_push_subscriptions"), "");
  assert.equal(one("SELECT encrypted AS v FROM gmail_mailboxes"), "");
  assert.equal(one("SELECT encrypted AS v FROM gmail_linked_mailboxes"), "");
  assert.equal(one("SELECT encrypted AS v FROM gmail_pending"), "");
  assert.equal(one("SELECT slot_token AS v FROM oauth_pending_states"), "");
  assert.equal(one("SELECT verifier AS v FROM oauth_pending_states"), "");
  assert.equal(one("SELECT private_seed AS v FROM referral_invite_keys WHERE room_id='commons'"), "");
  // And none of them is the export's placeholder.
  assert.notEqual(one("SELECT secret AS v FROM agent_webhook_subs WHERE subscription_id='sub-3599'"), sha(SECRETS.hook));
}

test("new export round trip (file replay): flag and verifier are identity, secrets substitute", t => {
  const { directory, store, accountId } = seed(t);
  const target = join(directory, "restored.sqlite");
  const result = replayNdjson(exportNdjsonText(store.db), target);
  assert.deepEqual(result.sanitizedCells, EXPECTED_SANITIZED);
  const restored = new RoomStore(target, { readOnly: true });
  try {
    assertIdentity(restored.db, accountId);
    assertSubstitutes(restored.db);
    assert.equal(new AccountLoginMethods(restored).emailVerification(accountId).passwordResetRequired, true);
  } finally { restored.close(); }
});

test("new export round trip (open store): sanitizedCells reports every substitution", t => {
  const { store, accountId } = seed(t);
  const target = emptyTarget(t);
  const result = replayNdjsonInto(exportNdjsonText(store.db), target);
  assert.equal(result.verified, true);
  assert.deepEqual(result.sanitizedCells, EXPECTED_SANITIZED);
  assertIdentity(target.db, accountId);
  assertSubstitutes(target.db);
  assert.equal(new AccountLoginMethods(target).emailVerification(accountId).passwordResetRequired, true);
});

test("new export round trip (streaming backup session): identical substitution", t => {
  const { store, accountId } = seed(t);
  const target = emptyTarget(t);
  const session = createBackupReplaySession(target);
  session.writeText(exportNdjsonText(store.db));
  const result = session.finish();
  assert.equal(result.verified, true);
  assert.deepEqual(result.sanitizedCells, EXPECTED_SANITIZED);
  assertIdentity(target.db, accountId);
  assertSubstitutes(target.db);
});

// A pre-#3599 export: no sanitizePolicy marker, the trailer dropped (the
// doctored rows no longer match its digests), and the two over-hashed
// columns carrying sha256 placeholders, exactly as the old exporter wrote.
function legacyStream(ndjson, { flagPlaceholder } = {}) {
  const out = [];
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.kind === "watermark") { delete record.sanitizePolicy; out.push(record); continue; }
    if (record.kind === "trailer") continue;
    if (record.table === "accounts") record.row.password_reset_required = flagPlaceholder ?? sha(String(record.row.password_reset_required));
    if (record.table === "bounty_records" && record.row.verifier != null) record.row.verifier = sha(record.row.verifier);
    out.push(record);
  }
  return out.map(record => JSON.stringify(record)).join("\n") + "\n";
}

test("legacy export: the flag's true value is recovered, the verifier is nulled and reported", t => {
  const { store, accountId } = seed(t);
  const target = emptyTarget(t);
  const result = replayNdjsonInto(legacyStream(exportNdjsonText(store.db)), target);
  assert.equal(result.verified, true);
  const cell = target.db.prepare("SELECT password_reset_required AS v, typeof(password_reset_required) AS t FROM accounts WHERE id=?").get(accountId);
  assert.equal(cell.v, 1);
  assert.equal(cell.t, "integer");
  assert.equal(new AccountLoginMethods(target).emailVerification(accountId).passwordResetRequired, true);
  // Unrecoverable authority loads as NULL (fails closed) and is reported.
  assert.equal(target.db.prepare("SELECT verifier FROM bounty_records WHERE bounty_id='b-3599'").get().verifier, null);
  assert.equal(result.sanitizedCells.accounts.password_reset_required, 1);
  assert.equal(result.sanitizedCells.bounty_records.verifier, 1);
});

test("legacy export: a clear flag stays clear", t => {
  const { store, accountId } = seed(t, { flag: 0 });
  const target = emptyTarget(t);
  replayNdjsonInto(legacyStream(exportNdjsonText(store.db)), target);
  assert.equal(target.db.prepare("SELECT password_reset_required AS v FROM accounts WHERE id=?").get(accountId).v, 0);
  assert.equal(new AccountLoginMethods(target).emailVerification(accountId).passwordResetRequired, false);
});

test("legacy export: an unrecognized flag placeholder refuses the restore", t => {
  const { store } = seed(t);
  const target = emptyTarget(t);
  const stream = legacyStream(exportNdjsonText(store.db), { flagPlaceholder: sha("2") });
  assert.throws(() => replayNdjsonInto(stream, target), /unrecognized placeholder in accounts\.password_reset_required/);
  // The refusal rolls back: the target is still empty and retryable.
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 0);
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM accounts").get().n, 0);
});
