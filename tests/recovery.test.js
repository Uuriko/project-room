import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { RoomStore } from "../server/store.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { backupRoom } from "../server/backup.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createRecoveryFixture } from "../scripts/recovery-fixture.mjs";
import { seedRecoveryCoverage } from "../scripts/recovery-coverage.mjs";
import { fenceDefinitions } from "../server/writer-fence.mjs";
import { appendOperatorAction } from "../server/operator-actions.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-recovery-"));
  const f = createRecoveryFixture(join(directory, "source.sqlite"));
  t.after(() => { f.store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...f, directory };
}

test("online capture preserves all application tables, identity boundaries and exact retries through recovery and restart", async t => {
  const f = fixture(t);
  const {
    runRequest, runInput, offerRecords, publicIdentity, publicClaimInput, publicClaimed,
    publicFinishInput, publicFinished, publicArtifact, publicVerifyInput, publicVerified,
    publicReviewInput, publicReviewed, publicReviewRows, publicReviewJournal, followRows,
    followJournal, followReceipt, followInput, followResult, captureSequence
  } = await seedRecoveryCoverage(f);
  assert.equal(followRows.length, 1); assert.equal(followJournal.length, 1);
  assert.equal(offerRecords.offers.length, 6);
  assert.deepEqual(new Set(offerRecords.offers.map(offer => offer.status)), new Set(["draft", "published", "withdrawn"]));
  // One append-only operator audit row so capture comparison cannot pass
  // while operator_actions is an empty sidecar.
  appendOperatorAction(f.store, {
    action: "purge.find", targetKind: "room", targetId: "commons",
    reason: "recovery fixture", planHash: null, counts: { rooms: 0 }, result: "found", requestId: "recovery-operator"
  });
  const before = auditRecovery(f.store);
  assert.equal(before.rooms, 2); assert.equal(before.tables.length, 168,
    "a table was added or removed: confirm the audit covers it, then update this count"); // +1: messages_backfill_cursor (cron message backfill cursor, empty until the integrity job); +2: private_update_marks, private_update_commands (Updates read/done/clear marks); +1: account_security_events; +1: messages (fenced message rows, schema v37); +1: operator_actions (append-only operator audit); +4: public_receipts, public_rooms, public_directory_entries, public_read_model_backfill (public page read model); +1: integrity_snapshot (cold-start checksum; empty until the yielding verify writes it); +2: public_work_successors/public_work_successor_requests; +2: public_work_reviews/public_work_review_requests; +4: public_work_tasks/public_work_requests/public_work_receipts/public_work_claim_writer_permit; +2: project_offers/project_offer_requests (public offer records and exact retry journal); +3: agent_api_keys, agent_directory_cards, agent_webhook_subs (RC-2026-09-18-010); +5: stitch_* tables; +2: agent_identity_verification, room_verification_policy (RC-2026-09-18-049); +2: agent_hosts, agent_wake_signals (RC-2026-09-18-051); +1: oauth_pending_states (RC-2026-09-19); +2: dm_consents, room_public_settings (consent-bound DMs + public face, 2026-09-20); +1: room_directory_settings (opt-in public room directory #605); +2: mention_states, room_mention_settings (mention lifecycle #658); +1: membership_delegation_grants (membership delegation #761); +7: bounty_journal, bounty_records, bounty_disputes, bounty_events, bounty_idempotency, bounty_watchers, bounty_sequences (credits-only bounty exchange #762); +1: agent_key_registry (agent public-key registry, integration-map slice #9); +1: inbox_handoff_rooms (room scope for collab-route handoffs); +4: bounty_rubric_versions, bounty_flakes, bounty_review_packets, bounty_sybil_flags (bounty slices 6+8+10: pinned rubrics, anti-flake ladder, sybil detector #792); +2: guest_invites, guest_members (GX guest-invite public handoff RC-2026-09-23-100); +3: activity_events, read_horizons, saved_messages (attention: activity feed, read horizons, saved messages); +1: thread_mutes (shared: attention thread mutes + server/thread-mutes.mjs); +1: bounty_reputation_packets (slice #4: probation-gate review packets); +1: referrals (referral attribution); +2: web_fetch_cache, web_fetch_log (room-side web fetch RC-2026-09-23-102); +3: agent_bonds, peer_dm_threads, peer_dm_messages (agent Bond and peer DMs); +1: jev_shadow_decisions (Jev shadow-gate journal); +1: agent_autonomy_tiers (graduated agent autonomy tiers #928, replaces slice 1/3 agent_operator_controls); +1: agent_skill_cards (evidence-backed skill cards RC-2026-09-24-202); +1: agent_push_configs (push wake path RC-2026-09-24-203); +1: identity_link_codes (identity-holder link codes RC-2026-09-24-210); +1: inbox_attachment_bytes (identity-scoped staged inbox attachment bytes); +1: web_research_log (knowledge router RC-2026-09-24-310); +1: land_queue (pull-request land queue); +1: web_fetch_cache_rooms (room-scoped fetch visibility, RC-2026-09-24-310 follow-up); +3: referral_invite_keys, referral_invites, referral_chain_members (signed agent-carried referral invites #1025); +2: private_next_action_dismissals, private_next_action_suppressions (ranked next-actions private state RC-2026-09-25-911); +1: telegram_live_status (durable Telegram live-delivery/send facts, task #10); +2: guest_selfserve, guest_selfserve_idem (self-serve guest entry RC-2026-09-25-912); +4: board_vtwo_claims, board_vtwo_events, board_vtwo_mirror, board_vtwo_idempotency (board-v2 durable registry PR #1144); +1: agent_capability_grants (per-agent capability grant edges, UFO-steal slice 1 RC-2026-09-27-2728); +2: owner_delegate_grants, owner_delegate_journal (owner-delegated agent authority PR #1182); +2: agent_work_wake_hosts, agent_work_wakes (opt-in work delivery on host heartbeats); +1: room_access_auto_approve (self-serve auto-approve rules RC-2026-09-29-3603); +2: room_schema_stamp, integrity_job_cursor (schema hash and deferred integrity cursor); +1: integrity_room_state (per-room sequence and projection size for the incremental check) +3: account_terms, public_abuse_reports, public_unpublish (terms acceptance, public abuse reports, operator unpublish)
  for (const table of before.tables) {
    if (table.table === "membership_delegation_pending") {
      assert.equal(table.rows, 0, "no rollback-era transitions remain after reconciliation");
      continue;
    }
    if (table.table === "room_access_auto_approve") {
      assert.equal(table.rows, 0, "no auto-approve rules configured in the fixture");
      continue;
    }
    if (table.table === "private_update_marks" || table.table === "private_update_commands") {
      assert.equal(table.rows, 0, "update marks exist only after a member reads, finishes, or clears an item");
      continue;
    }
    if (table.table === "integrity_snapshot") {
      assert.equal(table.rows, 0, "the checksum row is written only after the yielding verify, not on open");
      continue;
    }
    if (table.table === "integrity_job_cursor") {
      assert.equal(table.rows, 0, "the deferred integrity cursor is written by the cron, not on open");
      continue;
    }
    if (table.table === "messages_backfill_cursor") {
      assert.equal(table.rows, 0, "the message backfill cursor is written by the cron, not on open");
      continue;
    }
    if (table.table === "public_rooms" || table.table === "public_read_model_backfill") {
      assert.equal(table.rows, 0, "a public room page stays empty until an owner opts in, and the backfill cursor is written by cron");
      continue;
    }
    if (table.table === "integrity_room_state") {
      assert.equal(table.rows, 0, "per-room integrity state is written by the cron, not on open");
      continue;
    }
    assert.ok(table.rows > 0, `${table.table} has substantive fixture data`);
  }
  assert.equal(before.legacyCheckpoints, 1); assert.equal(before.replay.checkpointEvents, 2);
  const receipt = await backupRoom(f.filename, f.directory);
  assert.deepEqual(receipt.recovery, before);
  assert.equal(statSync(receipt.filename).mode & 0o777, 0o600);
  assert.equal(statSync(join(receipt.filename, "..")).mode & 0o777, 0o700);
  for (const privateValue of [f.keys.owner, f.pending.token, f.command.data.body, "recovery-target", f.projectOffers[0].record.summary]) assert.equal(JSON.stringify(before).includes(privateValue), false);
  const bytes = readFileSync(receipt.filename);
  const readonly = new RoomStore(receipt.filename, { readOnly: true, now: f.now });
  try { assert.deepEqual(auditRecovery(readonly), before); } finally { readonly.close(); }
  assert.deepEqual(readFileSync(receipt.filename), bytes, "verification is not repair or migration");

  // A captured copy intentionally lacks later revocations and writes. Do not
  // reopen it to users without reconciling authority and external effects.
  f.store.revoke(f.validSession.token);
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { body: "Synthetic post-capture write" } });
  assert.throws(() => f.store.authenticate(f.validSession.token), { code: "unauthenticated" });
  let recovered = new RoomStore(receipt.filename, { now: f.now });
  assert.deepEqual(recovered.workClaims.get("commons", "recovery-claim"), f.store.workClaims.get("commons", "recovery-claim"));
  assert.equal(recovered.workClaims.configFor("commons").defaultLeaseHours, 6);
  try {
    assert.equal(recovered.requestRuns.list(f.keys.owner, "commons").runs[runRequest.id].state, "working");
    assert.throws(() => recovered.requestRuns.apply(f.keys.agent, "commons", { ...runInput, attemptId: "replacement-host" }), { code: "request_run_owned" });
    assert.deepEqual(auditRecovery(recovered), before);
    assert.deepEqual(recovered.projectOffers.ownerList("commons", "owner"), offerRecords);
    assert.deepEqual(recovered.publicWorkClaims.act("public-recovery", publicIdentity.secret, "claim", publicClaimInput), publicClaimed);
    assert.deepEqual(recovered.publicWorkClaims.act("public-recovery", publicIdentity.secret, "finish", publicFinishInput), publicFinished);
    assert.deepEqual(recovered.publicWorkClaims.receipt(publicFinished.receipt.receiptId), publicFinished.receipt);
    assert.deepEqual(recovered.publicWorkClaims.artifact(publicFinished.receipt.receiptId), publicArtifact);
    assert.deepEqual(recovered.publicWorkReviews.verify("commons", "reply-reviewer", publicFinished.receipt.receiptId, publicVerifyInput), publicVerified);
    assert.deepEqual(recovered.publicWorkReviews.decide("commons", "owner", publicFinished.receipt.receiptId, publicReviewInput), publicReviewed);
    assert.deepEqual(recovered.db.prepare("SELECT * FROM public_work_reviews ORDER BY receipt_id").all(), publicReviewRows);
    assert.deepEqual(recovered.db.prepare("SELECT * FROM public_work_review_requests ORDER BY request_id").all(), publicReviewJournal);
    assert.deepEqual(recovered.db.prepare("SELECT * FROM public_work_successors ORDER BY parent_receipt_id").all(), followRows);
    assert.deepEqual(recovered.db.prepare("SELECT * FROM public_work_successor_requests ORDER BY request_id").all(), followJournal);
    assert.deepEqual(recovered.publicWorkSuccessors.create("commons", "owner", followReceipt.receiptId, followInput), followResult, "restoration retains the exact original creation outcome");
    assert.deepEqual(recovered.publicWorkReviews.contributorReview(publicIdentity.secret, followReceipt.receiptId).followUp, followResult.followUp);
    assert.deepEqual(recovered.publicWorkClaims.receipt(followReceipt.receiptId), followReceipt);

    assert.equal(recovered.db.prepare("SELECT enabled FROM public_work_claim_writer_permit").get().enabled, 0);
    for (const offer of f.projectOffers) for (const retry of offer.retries) {
      const result = retry.action === "create" ? recovered.projectOffers.create("commons", "owner", retry.input)
        : recovered.projectOffers.transition("commons", "owner", offer.offerId, retry.action, retry.input);
      assert.deepEqual(result, retry.result, "capture retains exact offer operation receipts");
    }
    assert.deepEqual(recovered.projectOffers.list().offers.map(offer => offer.id), ["follow-child", "follow-parent", "public-recovery", "recovery-offer:published"]);
    assert.throws(() => recovered.projectOffers.read("recovery-offer:withdrawn"), { code: "offer_not_found" });

    assert.equal(recovered.authenticate(f.validSession.token).member.id, "owner");
    for (const token of [f.revokedSession.token, f.keys.oldAgent, f.keys.commonsShared, f.keys.secondShared, f.loggedOut.token, f.sharedSession.token]) assert.throws(() => recovered.authenticate(token));
    assert.equal(recovered.authenticate(f.keys.agent).member.kind, "agent");
    assert.equal(recovered.authenticateAccountSession(f.owner.token, "commons", f.owner.session.sessionBinding).account.id, f.owner.session.account.id);
    assert.throws(() => recovered.snapshot(f.target.token, "commons", f.target.session.sessionBinding), /no membership/);
    assert.equal(recovered.previewInvitation(f.pending.token).status, "pending");
    assert.equal(recovered.issueInvitation(f.owner.token, "commons", f.pending).duplicate, true);
    assert.equal(recovered.command(f.keys.owner, "commons", f.command).duplicate, true);
    assert.equal(recovered.room("commons").sequence, captureSequence);
    assert.deepEqual(recovered.threadMutes.list(f.keys.owner, "commons").threadIds, ["recovery-reported", "recovery-thread"]);
    assert.deepEqual(recovered.threadMutes.list(f.keys.agent, "commons").threadIds, [], "thread mute stays private after restore");
    for (const reminder of f.reminders.filter(row => ![f.keys.commonsShared, f.keys.secondShared].includes(row.token))) {
      const retry = recovered.reminders.mutate(reminder.token, reminder.room, reminder.request);
      assert.equal(retry.duplicate, true); assert.deepEqual(retry.receipt, reminder.receipt);
    }
    assert.equal(recovered.reminders.list(f.keys.owner, "commons").reminders.length, 3);
    assert.equal(recovered.reminders.list(f.guestSlot.token, "commons").reminders.length, 1);
    const slot = recovered.accountSessionSlot(f.guestSlot.token);
    const retryJoin = recovered.shareLinks.join(f.guestSlot.token, f.linkToken, { ...f.joinRequest,
      expectedSessionRevision: slot.sessionRevision, expectedSessionBinding: slot.sessionBinding });
    assert.equal(retryJoin.duplicate, true); assert.equal(retryJoin.session.member.id, f.guest.session.member.id);
    assert.equal(recovered.shareLinks.list(f.keys.owner, "commons", null).links[0].joins, 1);
    assert.throws(() => recovered.shareLinks.preview(f.linkToken), { code: "link_unavailable" });
    const accepted = recovered.acceptInvitation(f.target.token, f.pending.token, { redemptionId: randomUUID(), expectedRevision: 0,
      expectedSessionBinding: f.target.session.sessionBinding });
    assert.equal(accepted.duplicate, false); assert.equal(accepted.session.member.id, "pending-human");
    const next = { id: "recovered-new-command", type: T.MESSAGE_POSTED, data: { body: "Synthetic new work after recovery" } };
    recovered.command(f.keys.owner, "commons", next);
    assert.equal(recovered.snapshot(f.keys.owner, "commons").cursor, f.cursor, "recovery never acknowledges new history");
    const after = auditRecovery(recovered);
    recovered.close(); recovered = new RoomStore(receipt.filename, { now: f.now });
    assert.deepEqual(auditRecovery(recovered), after);
    assert.equal(recovered.command(f.keys.owner, "commons", next).duplicate, true);
    assert.deepEqual(recovered.publicWorkSuccessors.create("commons", "owner", followReceipt.receiptId, followInput), followResult, "exact creation retry also survives a second recovered restart");
    assert.deepEqual(recovered.db.prepare("SELECT * FROM public_work_successor_requests ORDER BY request_id").all(), followJournal);
    assert.deepEqual(recovered.projectOffers.ownerList("commons", "owner"), offerRecords);
    const server = createRoomServer({ store: recovered, origin: "https://room.example.test" });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await new Promise((resolve, reject) => {
        const req = request({ hostname: "127.0.0.1", port: server.address().port, path: "/api/rooms/commons",
          headers: { host: "room.example.test", authorization: `Bearer ${f.keys.owner}` } }, res => {
          let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body }));
        }); req.on("error", reject); req.end();
      });
      assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).viewerId, "owner");
    } finally { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  } finally { recovered.close(); }
  assert.equal(f.store.room("commons").sequence, captureSequence + 1, "recovery writes never replace the source");
});

test("audit permits overdue, cancelled, resolved, rescheduled and backward-clock reminder histories", t => {
  const f = fixture(t), store = f.store;
  f.advance(120000); assert.doesNotThrow(() => auditRecovery(store));
  f.advance(-180000);
  const old = f.reminders.find(row => row.token === f.keys.owner && row.request.workItemId === "active");
  store.reminders.mutate(f.keys.owner, "commons", { ...old.request, requestId: "backward-clock", expectedRevision: 1, dueAt: f.now() + 3600000 });
  // A member removal resolves an active reminder; reactivation permits a fresh
  // schedule, leaving a legitimate one-revision gap in the receipt ledger.
  const member = () => store.room("commons").state.members.agent;
  for (const active of [false, true]) store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: "agent", expectedMemberRevision: member().revision, active, permissions: [] } });
  const agent = store.issueAccessKey("commons", "agent");
  store.reminders.mutate(agent, "commons", { requestId: "reactivated", workItemId: "active", expectedRevision: 2, action: "schedule", dueAt: f.now() + 60000 });
  assert.doesNotThrow(() => auditRecovery(store));
});

for (const fault of ["projection", "legacy-envelope", "missing-receipt", "receipt-fingerprint", "human-binding", "extra-table"])
  test(`read-only audit rejects ${fault} without repairing the source`, t => {
    const f = fixture(t), store = f.store, db = store.db;
    // Deliberate operator-level damage in this isolated fixture only.
    store.transaction(() => {
      if (fault === "projection") {
        const state = structuredClone(store.room("second").state); state.room.title = "Unrecorded edit";
        db.prepare("UPDATE rooms SET projection=? WHERE id='second'").run(JSON.stringify(state));
      } else if (fault === "legacy-envelope") {
        const row = db.prepare("SELECT id,body FROM events WHERE room_id='commons' AND sequence=1").get();
        const body = JSON.parse(row.body); body.at = "not a date";
        db.prepare("UPDATE events SET body=? WHERE id=?").run(JSON.stringify(body), row.id);
      } else if (fault === "missing-receipt" || fault === "receipt-fingerprint") {
        const trigger = `private_reminder_commands_no_${fault === "missing-receipt" ? "delete" : "update"}`;
        const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(trigger).sql; db.exec(`DROP TRIGGER ${trigger}`);
        if (fault === "missing-receipt") db.prepare("DELETE FROM private_reminder_commands WHERE room_id='commons' AND member_id='owner' AND request_id='schedule-cancelled'").run();
        else db.prepare("UPDATE private_reminder_commands SET fingerprint=? WHERE room_id='commons' AND member_id='owner' AND request_id='schedule-cancelled'").run(createHash("sha256").update("incorrect").digest("hex"));
        db.exec(sql);
      } else if (fault === "human-binding") db.prepare("DELETE FROM member_accounts WHERE room_id='commons' AND member_id='owner'").run();
      else db.exec("CREATE TABLE unexpected_table(value TEXT)");
    });
    const before = db.prepare("SELECT total_changes() n").get().n;
    assert.throws(() => auditRecovery(store));
    assert.equal(db.prepare("SELECT total_changes() n").get().n, before);
  });

test("v8 readonly verification refuses a v7 marker rather than migrating the backup", t => {
  const f = fixture(t); f.store.db.exec("PRAGMA user_version=7");
  assert.throws(() => new RoomStore(f.filename, { readOnly: true }), /schema|version|migration/i);
  assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 7);
});

test("read-only open accepts a v34 backup written before the additive wake queue and attention tables", t => {
  const f = fixture(t);
  const rooms = f.store.db.prepare("SELECT id,sequence FROM rooms ORDER BY id").all();
  const objects = () => f.store.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'wake_queue%' OR name LIKE 'private_attention%' ORDER BY name").all().map(row => row.name);
  const additive = objects();
  assert.ok(additive.includes("wake_queue") && additive.includes("private_attention_prefs"));
  // A half-present additive schema is a damaged file, not an older one.
  f.store.db.exec("DROP TABLE wake_queue_commands; DROP TABLE private_attention_commands");
  assert.throws(() => new RoomStore(f.filename, { readOnly: true }), /Wake queue schema requires operator reconciliation/);
  f.store.db.exec("DROP TABLE wake_queue; DROP TABLE private_attention_prefs; DROP TABLE wake_queue_pause");
  assert.deepEqual(objects(), [], "fixture now matches a pre-W4-45 file");
  const older = new RoomStore(f.filename, { readOnly: true, now: f.now });
  try {
    assert.deepEqual(older.db.prepare("SELECT id,sequence FROM rooms ORDER BY id").all(), rooms);
    assert.equal(older.room("commons").state.room.id, "commons");
    assert.equal(older.wakeQueue.verifySchema({ allowAbsent: true }), false);
    assert.equal(older.attention.verifySchema({ allowAbsent: true }), false);
    assert.throws(() => older.wakeQueue.verifySchema(), /Wake queue schema/, "a writable open still requires the tables");
  } finally { older.close(); }
  assert.deepEqual(objects(), [], "read-only verification is not migration");
  // Only the additive tables are optional: a wrong schema marker still fails.
  f.store.db.exec("PRAGMA user_version=27");
  assert.throws(() => new RoomStore(f.filename, { readOnly: true }), /requires schema v37/);
  f.store.db.exec("PRAGMA user_version=34");
  // A true v34 file carries v34 writer triggers, not v35 ones; the doctored
  // marker alone would leave the file self-inconsistent and the fence
  // (correctly) refuses it. Swap the trigger generation for the tables still
  // present (absent additive tables are skipped, per the fence's own rule) so
  // the file is self-consistent; the writable migration below reinstalls the
  // v36 set.
  const v34Tables = new Set(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  for (const row of f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'writer_v37_*'").all()) {
    f.store.db.exec(`DROP TRIGGER "${row.name}"`);
  }
  for (const { name, sql } of fenceDefinitions(34)) {
    if (v34Tables.has(name.replace(/^writer_v34_/, "").replace(/_(insert|update|delete)$/, ""))) f.store.db.exec(sql);
  }
  // A writable open recreates the additive tables and then verifies them strictly.
  const upgraded = new RoomStore(f.filename, { now: f.now });
  try {
    assert.equal(upgraded.wakeQueue.verifySchema(), true);
    assert.equal(upgraded.attention.verifySchema(), true);
  } finally { upgraded.close(); }
  assert.deepEqual(objects(), additive, "the service, not read-only verification, restores the additive schema");
});
