// SLA sweep hook wiring (task 26), exercised through a real store. These
// tests prove the two injected hooks the sweep degrades honestly without are
// now live on the inbox's own thread store:
// - createInboxThreadReader: enumerates genuinely live threads via
//   Inbox.slaThreadScan — the same pipeline as the thread view, no invented
//   store, no duplicated direction rules.
// - createSlaBreachDeliver: routes breach records the urgent path decides to
//   deliver into the durable in-app alert journal (store.slaBreachAlerts),
//   recording the decision, reason, and prefs snapshot.
// The suite drives the full path: import real stored email, tick a real
// SlaSweeper wired with the real hooks, and read the journal back.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";
import { SlaSweeper, SLA_BREACH_KIND } from "../server/sla-sweep.mjs";
import { createInboxThreadReader, createSlaBreachDeliver, SlaSweepHookError } from "../server/sla-sweep-hooks.mjs";
import { createNotifyPrefs } from "../server/notify-prefs.mjs";

const HOUR = 3600000;
const address = (name, addr) => ({ emailAddress: { name, address: addr } });

function fixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
  f.session = { account, token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  f.configuredConnections = new Set();
  f.makeEmail = emailAccountId => {
    const email = emailContractFixture(); email.connection.accountId = emailAccountId;
    return email;
  };
  // Import one stored email message. arrivalAgoMs anchors the SLA clock;
  // from/to/inReplyTo control the direction the sweep will clock. The import
  // runs under the given account session, so it lands in that account's store.
  f.importEmail = (email, who, { messageId, internetMessageId, conversationId, subject, arrivalAgoMs,
    from = address("Avery", "avery@example.test"), to = [address("Morgan", "morgan@example.test")],
    inReplyTo = null, body = "Stored message for the SLA sweep." }) => {
    if (!f.configuredConnections.has(email.connection.id)) {
      f.store.email.apply(who.token, { action: "connection.configure", requestId: randomUUID(),
        connectionId: email.connection.id, expectedRevision: 0, profile: structuredClone(email.connection) }, who.binding);
      f.configuredConnections.add(email.connection.id);
    }
    const m = email.message;
    m.id = messageId; m.internetMessageId = internetMessageId; m.conversationId = conversationId;
    m.subject = subject; m.body.content = body; m.from = from; m.toRecipients = to;
    m.internetMessageHeaders = inReplyTo ? [{ name: "In-Reply-To", value: inReplyTo }] : [];
    const arrived = new Date(Date.now() - arrivalAgoMs).toISOString();
    m.sentDateTime = arrived; m.receivedDateTime = arrived;
    email.options.attachmentObservation.messageId = messageId;
    email.options.attachmentObservation.messageRevision = m.changeKey;
    const envelope = normalizeGraphEmail(email.connection, m, email.options);
    const state = f.store.email.state(who.token, email.connection.id, m.parentFolderId, who.binding);
    f.store.email.apply(who.token, { action: "page.apply", requestId: randomUUID(), connectionId: email.connection.id,
      connectionRevision: email.connection.revision, folderId: m.parentFolderId,
      expectedRevision: state.folder?.revision ?? 0, expectedCursor: state.expectedCursor, cursor: randomUUID(),
      reset: state.needsReset, complete: true, observations: [{ kind: "message", expectedSourceRevision: 0, envelope }] }, who.binding);
    return envelope.sourceId;
  };
  f.ownerWho = () => ({ token: f.session.token, binding: f.session.sessionBinding });
  // A sweeper wired with the real hooks for the fixture's owner account.
  f.wire = ({ prefs = null, session = null, accountId = null, ownerId = null } = {}) => {
    const notifyPrefs = prefs ?? createNotifyPrefs();
    const who = session ?? { token: f.session.token, binding: f.session.sessionBinding };
    const sweeper = new SlaSweeper({
      readThreads: createInboxThreadReader({ inbox: f.store.inbox, session: who, limit: 100 }),
      deliver: createSlaBreachDeliver({ journal: f.store.slaBreachAlerts,
        accountId: accountId ?? account.id, notifyPrefs }),
      notifyPrefs, ownerId: ownerId ?? account.id,
    });
    return { sweeper, notifyPrefs };
  };
  f.account = account;
  return f;
}
const importBreachedEmail = f => {
  const email = f.makeEmail(f.account.id);
  f.importEmail(email, f.ownerWho(), { messageId: "sweep-m1", internetMessageId: "<sweep-1@example.test>",
    conversationId: "conv-sweep", subject: "Waiting on you", arrivalAgoMs: 30 * HOUR });
  return email;
};

// --- the hooks are live on the real inbox store --------------------------------
test("a genuinely breached inbound thread is enumerated from the inbox store and journaled in-app", async t => {
  const f = fixture(t);
  importBreachedEmail(f);
  const { sweeper } = f.wire();
  const summary = await sweeper.tick();
  assert.equal(summary.kind, SLA_BREACH_KIND);
  assert.equal(summary.threads, 1, "one live thread scanned");
  assert.equal(summary.produced, 1); assert.equal(summary.delivered, 1);
  assert.equal(summary.muted, 0); assert.equal(summary.deferred, 0); assert.equal(summary.errors, 0);
  assert.equal(summary.scanError, null);
  const alerts = f.store.slaBreachAlerts.list(f.account.id);
  assert.equal(alerts.length, 1, "the delivered breach is journaled in-app");
  const receipt = alerts[0];
  assert.ok(Object.isFrozen(receipt), "journal views are frozen");
  assert.equal(receipt.channel, "email");
  assert.equal(receipt.kind, SLA_BREACH_KIND);
  assert.equal(receipt.targetMs, 24 * HOUR, "email target is the provisional 24h");
  assert.ok(receipt.elapsedMs >= 30 * HOUR, "clock measures the stored arrival");
  assert.equal(receipt.decision, "deliver");
  assert.match(receipt.reason, /urgent/i);
  assert.ok(receipt.prefsSnapshot && typeof receipt.prefsSnapshot === "object", "prefs snapshot journaled");
  assert.match(receipt.threadId, /^email:mail-fixture:conv-sweep$/, "thread id is the inbox-namespaced id, not invented");
});

test("an owner reply clears the thread from the open sweep", async t => {
  const f = fixture(t);
  const email = importBreachedEmail(f);
  f.importEmail(email, f.ownerWho(), { messageId: "sweep-m2", internetMessageId: "<sweep-2@example.test>",
    conversationId: "conv-sweep", subject: "Re: Waiting on you", arrivalAgoMs: 29 * HOUR,
    from: address("Morgan", "morgan@example.test"), to: [address("Avery", "avery@example.test")],
    inReplyTo: "<sweep-1@example.test>", body: "Answered — the clock stops." });
  const { sweeper } = f.wire();
  const summary = await sweeper.tick();
  assert.equal(summary.threads, 1, "the thread is still scanned");
  assert.equal(summary.produced, 0, "answered threads are not breaches");
  assert.equal(summary.delivered, 0);
  assert.equal(f.store.slaBreachAlerts.list(f.account.id).length, 0);
});

test("a new breach after the thread clears re-alerts with a fresh journaled receipt", async t => {
  const f = fixture(t);
  const email = importBreachedEmail(f);
  const { sweeper } = f.wire();
  await sweeper.tick();
  f.importEmail(email, f.ownerWho(), { messageId: "sweep-m2", internetMessageId: "<sweep-2@example.test>",
    conversationId: "conv-sweep", subject: "Re: Waiting on you", arrivalAgoMs: 29 * HOUR,
    from: address("Morgan", "morgan@example.test"), to: [address("Avery", "avery@example.test")],
    inReplyTo: "<sweep-1@example.test>", body: "Answered — the clock stops." });
  await sweeper.tick();
  f.importEmail(email, f.ownerWho(), { messageId: "sweep-m3", internetMessageId: "<sweep-3@example.test>",
    conversationId: "conv-sweep", subject: "Re: Waiting on you", arrivalAgoMs: 26 * HOUR,
    inReplyTo: "<sweep-2@example.test>", body: "Following up — still waiting." });
  const summary = await sweeper.tick();
  assert.equal(summary.produced, 1, "the new breach re-alerts after the clear");
  assert.equal(summary.delivered, 1);
  assert.equal(f.store.slaBreachAlerts.list(f.account.id).length, 2, "one receipt per produced record");
});

// --- the urgent path, not a new path --------------------------------------------
test("quiet hours do not stop an urgent breach; the journaled decision says why", async t => {
  const f = fixture(t);
  importBreachedEmail(f);
  const prefs = createNotifyPrefs();
  prefs.setQuietHours(f.account.id, { start: "00:00", end: "23:59" });
  const { sweeper } = f.wire({ prefs });
  const summary = await sweeper.tick();
  assert.equal(summary.delivered, 1, "urgent bypasses quiet hours");
  const receipt = f.store.slaBreachAlerts.list(f.account.id)[0];
  assert.equal(receipt.decision, "deliver");
  assert.match(receipt.reason, /urgent/i, "the journaled reason records the bypass");
});

test("muted-all still mutes: the alert stays active and nothing is journaled", async t => {
  const f = fixture(t);
  importBreachedEmail(f);
  const prefs = createNotifyPrefs();
  prefs.setGlobal(f.account.id, { level: "muted" });
  const { sweeper } = f.wire({ prefs });
  const summary = await sweeper.tick();
  assert.equal(summary.muted, 1); assert.equal(summary.delivered, 0);
  assert.equal(f.store.slaBreachAlerts.list(f.account.id).length, 0, "muted alerts never journal");
  assert.equal(sweeper.activeAlerts().length, 1, "the breach stays active for re-evaluation");
});

// --- honest degradation is preserved where data is truly absent ------------------
test("an empty store scans to zero threads — honest, never invented", async t => {
  const f = fixture(t);
  const { sweeper } = f.wire();
  const summary = await sweeper.tick();
  assert.equal(summary.threads, 0);
  assert.equal(summary.produced, 0); assert.equal(summary.delivered, 0);
  assert.equal(summary.scanError, null, "zero threads is a real result, not an outage");
});

test("messages with no direction (no one owes a reply) are not enumerated", async t => {
  const f = fixture(t);
  const email = f.makeEmail(f.account.id);
  f.importEmail(email, f.ownerWho(), { messageId: "sweep-mx", internetMessageId: "<sweep-x@example.test>",
    conversationId: "conv-unrelated", subject: "Not yours", arrivalAgoMs: 30 * HOUR,
    from: address("Xenia", "x@example.test"), to: [address("Yara", "y@example.test")] });
  const { sweeper } = f.wire();
  const summary = await sweeper.tick();
  assert.equal(summary.threads, 0, "unrelated mail carries no SLA clock");
  assert.equal(summary.scanError, null);
});

test("an invalid session surfaces as scanError, never as fake threads", async t => {
  const f = fixture(t);
  importBreachedEmail(f);
  const { sweeper } = f.wire({ session: { token: "bogus", binding: "bogus" } });
  const summary = await sweeper.tick();
  assert.ok(summary.scanError, "the tick reports the auth failure");
  assert.equal(summary.produced, 0); assert.equal(summary.delivered, 0);
  assert.equal(f.store.slaBreachAlerts.list(f.account.id).length, 0);
});

// --- account scoping --------------------------------------------------------------
test("threads and alerts are account-scoped: one owner's sweep never sees the other's", async t => {
  const f = fixture(t);
  const guestAccount = f.store.accountForMember("commons", "guest");
  const guestKey = f.store.issueAccountAccessKey(guestAccount.id), guestSlot = f.store.createAccountSessionSlot();
  const guestSession = { token: guestSlot.token, ...f.store.loginAccountSession(guestSlot.token, guestKey, 0) };
  const guestWho = { token: guestSession.token, binding: guestSession.sessionBinding };
  const guestEmail = f.makeEmail(guestAccount.id);
  guestEmail.connection.id = "mail-fixture-guest";
  f.importEmail(guestEmail, guestWho, { messageId: "sweep-g1", internetMessageId: "<sweep-g1@example.test>",
    conversationId: "conv-guest", subject: "Guest waiting", arrivalAgoMs: 30 * HOUR });
  const guestWired = f.wire({ session: guestWho, accountId: guestAccount.id, ownerId: guestAccount.id });
  const guestSummary = await guestWired.sweeper.tick();
  assert.equal(guestSummary.produced, 1, "the guest's own thread breaches on the guest sweep");
  const ownerWired = f.wire();
  const ownerSummary = await ownerWired.sweeper.tick();
  assert.equal(ownerSummary.threads, 0, "the owner's sweep cannot see the guest's threads");
  assert.equal(ownerSummary.produced, 0);
  assert.equal(f.store.slaBreachAlerts.list(f.account.id).length, 0, "no alert leaks to the owner");
  assert.equal(f.store.slaBreachAlerts.list(guestAccount.id).length, 1);
});

// --- deliver idempotency and hook validation ----------------------------------------
test("re-delivering the same produced record files one receipt, not two", async t => {
  const f = fixture(t);
  importBreachedEmail(f);
  const { sweeper } = f.wire();
  await sweeper.tick();
  const deliver = createSlaBreachDeliver({ journal: f.store.slaBreachAlerts, accountId: f.account.id,
    notifyPrefs: createNotifyPrefs() });
  const record = sweeper.activeAlerts()[0];
  const decision = { decision: "deliver", reason: "manual re-delivery of the same produced record" };
  await deliver(record, decision);
  await deliver(record, decision);
  assert.equal(f.store.slaBreachAlerts.list(f.account.id).length, 1, "same (thread, producedAt) files once");
});

test("hook factories fail loudly on bad wiring instead of degrading silently", () => {
  assert.throws(() => createInboxThreadReader({}), err => err instanceof SlaSweepHookError, "inbox required");
  assert.throws(() => createInboxThreadReader({ inbox: { slaThreadScan() {} } }),
    err => err instanceof SlaSweepHookError, "session required");
  assert.throws(() => createSlaBreachDeliver({}), err => err instanceof SlaSweepHookError, "journal required");
  assert.throws(() => createSlaBreachDeliver({ journal: { notify() {} } }),
    err => err instanceof SlaSweepHookError, "accountId required");
});
