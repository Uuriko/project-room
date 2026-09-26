import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { RoomStore } from "../server/store.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { backupRoom } from "../server/backup.mjs";
import { flagMessage } from "../server/inbox-spam.mjs";
import { createNotifyPrefs } from "../server/notify-prefs.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createRecoveryFixture } from "../scripts/recovery-fixture.mjs";
import { fenceDefinitions } from "../server/writer-fence.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-recovery-"));
  const f = createRecoveryFixture(join(directory, "source.sqlite"));
  t.after(() => { f.store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...f, directory };
}

test("online capture preserves all 118 tables, identity boundaries and exact retries through recovery and restart", async t => {
  const f = fixture(t);
  const { identityId } = f.store.identities.create("Recovery agent");
  f.store.identities.link(f.keys.owner, "commons", { identityId, permissions: ["steer"] });
  f.store.invites.create(f.keys.owner, "commons", { permissions: ["steer"] });
  f.store.wakeQueue.enqueue(f.keys.owner, "commons", { requestId: "recovery-wake", queueKey: "recipe:recovery", intent: { recipe: "recovery" }, dueAt: f.now(), maxAttempts: 3 });
  f.store.attention.mutate(f.keys.owner, "commons", { requestId: "recovery-attention", quietStart: 22 * 60, quietEnd: 7 * 60, delivery: "immediate", digestHour: null });
  f.store.channelUpdates.record(f.emailProfile.accountId, f.emailProfile.id, [{ update_id: 1, message: { text: "journaled webhook update" } }], { backlog: 500 });
  // Seed one agent handoff so the capture comparison covers inbox_handoffs.
  f.store.handoffs.create(f.emailProfile.accountId, {
    threadId: "recovery-thread", channel: "email", sourceIds: ["recovery-source"],
    sender: { id: "recovery@example.test", label: "Recovery" }, subject: "Recovery handoff",
    occurredAt: new Date(f.now()).toISOString(), sla: null,
    triage: { action: "needs_human", reasons: ["recovery fixture handoff"] },
    summary: "Seeded so the capture covers inbox_handoffs.",
  }, { to: "recovery-agent", recordRoom: "commons" }); // and inbox_handoff_rooms, which scopes it to a room
  f.store.wakeQueue.pause(f.keys.owner, "commons", { requestId: "recovery-pause", reason: "inspecting" });
  f.store.command(f.keys.agent, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "recovery-reported", body: "synthetic message the owner reports" } });
  f.store.moderation.report(f.keys.owner, "commons", { messageId: "recovery-reported", reason: "recovery fixture report" });
  f.store.threadMutes.set(f.keys.owner, "commons", { threadId: "recovery-reported", muted: true });
  // The v34 convergence fences room_attachments: seed one staged row so the
  // capture comparison covers the table. roomAttachments.stage is the product
  // writer; this fixture inserts directly so the audit row needs no identity.
  f.store.db.prepare(`INSERT INTO room_attachments(room_id,id,uploader_id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at,message_id)
    VALUES('commons','recovery-attachment','recovery-uploader','recovery-note.txt','text/plain',11,?,?,'staged',?, ?,NULL)`)
    .run("0".repeat(64), Buffer.from("hello world"), f.now(), f.now() + 1000);
  // Seed one typed handoff envelope so the capture comparison covers
  // handoff_envelopes. The table arrived with the envelope journal and had no
  // fixture row, which the "every table has substantive data" assertion below
  // is there to catch - it is a coverage gate, not a formality.
  // A complete envelope, not startEnvelope's template: that helper leaves
  // inputs, authority.permissions and the acceptance checks empty, all of
  // which its own validator refuses, so it cannot be journalled as-is.
  f.store.handoffEnvelopes.create("commons", {
    to: "recovery-partner",
    objective: "Seeded so the capture covers handoff_envelopes.",
    inputs: [{ kind: "message", ref: "recovery-reported", label: "the reported message" }],
    authority: { permissions: ["accept_work"], scope: { rooms: ["commons"] }, expiresAt: new Date(f.now() + 24 * 3600 * 1000).toISOString() },
    expectedOutput: { kind: "text_result", description: "A short synthetic result" },
    acceptanceTest: { checks: [{ kind: "result_submitted", workId: "recovery-work" }] },
    termination: { expiresAt: new Date(f.now() + 24 * 3600 * 1000).toISOString(), onExpiry: "release", escalateTo: null },
    provenance: { claimId: null, taskId: null, chain: [] }
  }, { from: "recovery-agent" });
  // Seed one webhook delivery so the capture comparison covers
  // agent_webhook_deliveries. Written directly, like room_attachments and
  // access_requests above: the only store API that creates one is a wake ping
  // fan-out, which needs a live subscription this fixture has no reason to own.
  f.store.db.prepare(`INSERT INTO agent_webhook_deliveries
    (delivery_id,idempotency_key,subscription_id,agent_id,event_id,event_type,room_id,payload_json,signature,state,attempts,next_attempt_at,last_error,created_at,updated_at)
    VALUES('recovery-delivery','recovery-delivery-key','recovery-subscription','recovery-agent',NULL,'wake.ping','commons','{"kind":"wake.ping"}','sha256=recovery','pending',0,?,NULL,?,?)`)
    .run(f.now() + 1000, f.now(), f.now());
  // Seed one dismissal and one suppression so the capture comparison covers
  // private_next_action_dismissals and private_next_action_suppressions
  // (ranked next-actions private state RC-2026-09-25-911). Written directly:
  // the store API needs an authenticated token and the fixture's keys are
  // already committed to other seeding paths.
  f.store.db.prepare(`INSERT INTO private_next_action_dismissals
    (room_id,member_id,action_id,dismissed_at,expires_at,reason)
    VALUES('commons','recovery-agent','na:recovery-dismissed',?,?,?)`)
    .run(f.now(), f.now() + 14 * 24 * 3600 * 1000, "seeded so the capture covers private_next_action_dismissals");
  f.store.db.prepare(`INSERT INTO private_next_action_suppressions
    (room_id,member_id,kind,reason,updated_at)
    VALUES('commons','recovery-agent','poll-closing','seeded so the capture covers private_next_action_suppressions',?)`)
    .run(f.now());
  // Seed one pending OAuth state so the capture covers oauth_pending_states
  // (RC-2026-09-19: PKCE state moved into SQLite so a Worker isolate can be
  // evicted between the provider redirect and the callback). It is short-lived
  // and it is not room data, but the audit's claim is that it covers every
  // table, so a table with no fixture row is a hole in the claim.
  f.store.oauthPendingStateCreate({ provider: "google", stateHash: "1".repeat(64), slotToken: "recovery-slot",
    expectedRevision: 0, verifier: "recovery-pkce-verifier", expiresAt: f.now() + 600000, link: false });
  // Seed one read marker so the capture comparison covers private_inbox_reads.
  f.store.inbox.apply(f.owner.token, { action: "source.read", requestId: "recovery-inbox-read", sourceId: "recovery-source", expectedRevision: 1 }, f.owner.session.sessionBinding);
  f.cursor = f.store.room("commons").sequence;
  f.store.markCaughtUp(f.keys.owner, "commons", f.cursor);
  // Seed one access request so the capture comparison covers access_requests.
  f.store.db.prepare(`INSERT INTO access_requests(request_id,room_id,identity_id,display_name,requested_permissions,note,status,created_at)
    VALUES('recovery-access-request','commons',?,?,?,'recovery note','pending',?)`)
    .run(identityId, "Recovery agent", JSON.stringify(["read"]), f.now());
  // Seed one agent-room ownership record so the capture covers agent_room_ownership.
  f.store.db.prepare(`INSERT INTO agent_room_ownership(identity_id,room_id,created_at) VALUES(?,?,?)`)
    .run(identityId, "commons", f.now());
  // Seed one membership delegation grant so the capture covers membership_delegation_grants
  // (owner-granted membership administration #761). Written directly: the grant path
  // requires a live owner session the fixture has no reason to own.
  f.store.db.prepare(`INSERT INTO membership_delegation_grants(room_id,identity_id,granted_by,granted_at,revoked_at,added_invite_member)
    VALUES('commons',?,'owner',?,NULL,1)`)
    .run(identityId, f.now());
  // Seed wakeable-presence rows so the capture covers agent_hosts and agent_wake_signals (RC-2026-09-18-051).
  f.store.db.prepare(`INSERT INTO agent_hosts(agent_id,host_id,mode,wake_url,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
    .run(identityId, "recovery-host", "wakeable", "https://recovery.example.test/wake", f.now(), f.now(), f.now());
  f.store.db.prepare(`INSERT INTO agent_wake_signals(signal_id,agent_id,kind,room_id,message_id,created_at,delivered_at) VALUES(?,?,?,?,?,?,?)`)
    .run("recovery-signal", identityId, "mention", "commons", "recovery-message", f.now(), null);
  // Seed a push-subscription row so the capture covers agent_push_configs
  // (push wake path RC-2026-09-24-203). Written directly: the subscribe path
  // needs a public-resolving push url the fixture has no reason to own.
  f.store.db.prepare(`INSERT INTO agent_push_configs(agent_id,host_id,cadence_seconds,push_url,push_token,push_auth_json,push_failures,push_suspended,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(identityId, "recovery-host", 30, "https://recovery.example.test/push", "recovery-push-token", null, 0, 0, f.now());
  // Seed one GX guest invite + its redeemed seat so the capture covers
  // guest_invites and guest_members (RC-2026-09-23-100). Written directly:
  // the mint path needs a live owner account session the fixture has no
  // reason to own. The invite is recorded as redeemed so the seat row has a
  // matching invite, like a real redemption.
  f.store.db.prepare(`INSERT INTO guest_invites
    (id,code_hash,room_id,tier,credential_ttl_ms,guest_label,minted_by_member_id,minted_by_account_id,issue_request_id,created_at,redeem_by,status,redeemed_at,redeemed_by_identity_id,redeemed_member_id,revoked_at,revoked_by_member_id)
    VALUES('recovery-guest-invite',?, 'commons','observer',259200000,'Recovery guest','owner',NULL,'recovery-guest-issue',?,?, 'redeemed',?,?,?,NULL,NULL)`)
    .run("a".repeat(64), f.now(), f.now() + 86400000, f.now(), identityId, "guest-agent-recovery");
  f.store.db.prepare(`INSERT INTO guest_members(member_id,room_id,guest_identity_id,tier,invite_id,created_at)
    VALUES('guest-agent-recovery','commons',?,'observer','recovery-guest-invite',?)`)
    .run(identityId, f.now());
  // Seed one referral invite (redeemed) + its key row + chain membership so
  // the capture covers referral_invite_keys, referral_invites and
  // referral_chain_members (#1025 signed agent-carried referral invites).
  // Written directly: the mint path needs a live member session the fixture
  // has no reason to own; the key row mimics the lazily generated room key.
  f.store.db.prepare(`INSERT INTO referral_invite_keys (room_id, public_key, private_seed, created_at)
    VALUES('commons', ?, ?, ?)`)
    .run("a".repeat(64), "b".repeat(64), f.now());
  f.store.db.prepare(`INSERT INTO referral_invites
    (jti, room_id, chain_id, inviter_member_id, depth, max_depth, created_at, expires_at, status,
     rejected_at, reject_reason, redeemed_at, redeemed_member_id, redeemed_identity_id)
    VALUES('recovery-referral-jti','commons','recovery-chain','owner',0,6,?,?, 'redeemed',NULL,NULL,?, 'referred-agent-recovery', ?)`)
    .run(f.now(), f.now() + 7 * 86400000, f.now(), identityId);
  f.store.db.prepare(`INSERT INTO referral_chain_members (room_id, member_id, chain_id, depth, max_depth)
    VALUES('commons','referred-agent-recovery','recovery-chain',0,6)`).run();
  // Seed one of each Lane D plug-in row so the capture covers agent_api_keys,
  // agent_directory_cards and agent_webhook_subs.
  f.store.agentPlugin.issueApiKey({ identityId, scopes: ["rooms:read"], label: "recovery-key" });
  // RC-2026-09-18-014: the seeded card must be signed like any real publish.
  const recoveryCard = { name: "Recovery Agent", description: "Synthetic recovery fixture agent.", capabilities: ["chat"], version: "1.0.0" };
  const recoveryKeyPair = generateKeyPair();
  f.store.agentPlugin.publishCard({ identityId, agentId: "recovery-agent",
    card: recoveryCard, publicKey: recoveryKeyPair.publicKey,
    signature: signCard({ agentId: "recovery-agent", card: recoveryCard, privateKey: recoveryKeyPair.privateKey }),
    visibility: "public" });
  f.store.agentPlugin.subscribeWebhook({ identityId, url: "https://hooks.example.test/recovery", events: ["message.posted"] });
  // Seed one verification attestation and one room gate so the capture covers
  // agent_identity_verification and room_verification_policy (RC-2026-09-18-049).
  f.store.agentPlugin.verifyIdentity({ identityId, verifiedBy: "owner" });
  f.store.agentPlugin.setRoomVerificationPolicy({ roomId: "commons", requireVerified: true, setBy: "owner" });
  // Seed one direct channel send so the capture covers direct_channel_sends.
  f.store.db.prepare(`INSERT INTO direct_channel_sends(id,account_id,channel,recipient,subject,body_hash,thread_id,status,provider_id,error_code,created_at,updated_at)
    VALUES('recovery-direct-send',?,'telegram','123456','',?,NULL,'sent','4242',NULL,?,?)`)
    .run(f.emailProfile.accountId, "a".repeat(64), f.now(), f.now());
  // Seed one row per multi-method login table so the capture covers them
  // (the login slices created the tables but no fixture rows).
  f.store.db.prepare(`INSERT OR IGNORE INTO accounts(id,active,revision,auth_epoch,origin,created_at)
    VALUES('recovery-account',1,0,0,'recovery',?)`).run(f.now());
  f.store.db.prepare(`INSERT INTO account_login_methods(id,account_id,type,provider,label,email,email_hash,verifier,external_subject,created_at,last_used_at,disabled)
    VALUES('recovery-login-method','recovery-account','oauth','google','Recovery Google','recovery-login@example.com',?,NULL,'recovery-subject',?,NULL,0)`)
    .run("b".repeat(64), f.now());
  f.store.db.prepare(`INSERT INTO account_passkey_credentials(credential_id,account_id,method_id,rp_id,public_key_cose,public_key_jwk,sign_count,aaguid,fmt,transports,created_at,last_used_at,disabled)
    VALUES('recovery-credential','recovery-account','recovery-login-method','example.com','recovery-cose','recovery-jwk',0,NULL,'none',NULL,?,NULL,0)`)
    .run(f.now());
  f.store.db.prepare(`INSERT INTO account_magic_codes(code_hash,account_id,email,email_hash,expires_at,consumed_at,attempts,created_at)
    VALUES(?,'recovery-account','recovery-magic@example.com',?,?,NULL,0,?)`)
    .run("c".repeat(64), "d".repeat(64), f.now() + 600000, f.now());
  f.store.db.prepare(`INSERT INTO account_recovery_codes(code_hash,account_id,used_at,created_at)
    VALUES(?,'recovery-account',NULL,?)`)
    .run("e".repeat(64), f.now());
  // Seed one row per stitch table so the capture covers them (the stitch
  // slice created the tables but no fixture rows).
  const stitchAccount = f.emailProfile.accountId, stitchKey = `v1:${"a".repeat(64)}`;
  f.store.db.prepare(`INSERT INTO stitch_identities(account_id,stitch_key,id_type,channel,kind,first_seen,last_seen,occurrences)
    VALUES(?,?,'mailbox','email','mailbox','2026-09-01','2026-09-18',1)`).run(stitchAccount, stitchKey);
  f.store.db.prepare(`INSERT INTO stitch_links(account_id,stitch_key,channel,source_id,linked_at,link_rule,link_score)
    VALUES(?,?,'email','recovery-source','2026-09-18','exact_address',1.0)`).run(stitchAccount, stitchKey);
  f.store.db.prepare(`INSERT INTO stitch_revocations(account_id,stitch_key,channel,source_id,reason,revoked_at)
    VALUES(?,?,'email','recovery-old-source','wrong_match',?)`).run(stitchAccount, stitchKey, f.now());
  f.store.db.prepare(`INSERT INTO stitch_suggestions(suggestion_id,account_id,stitch_key_a,stitch_key_b,channel_a,channel_b,score,components_json,status,created_at)
    VALUES('recovery-suggestion',?,?,?,'email','email',0.9,'{}','pending',?)`)
    .run(stitchAccount, stitchKey, `v1:${"b".repeat(64)}`, f.now());
  f.store.db.prepare(`INSERT INTO stitch_receipts(receipt_id,account_id,action,stitch_key,payload_json,created_at)
    VALUES('recovery-receipt',?,'link',?, '{}',?)`).run(stitchAccount, stitchKey, f.now());
  // Seed one row per collab table so the capture covers them (Lane C created
  // the tables but no fixture rows). Synthetic data only.
  f.store.db.prepare(`INSERT INTO collab_assignments(room_id,thread_id,assignment_id,ops_json,record_json,clock_json,id_json,updated_at)
    VALUES('commons','recovery-thread','recovery-assignment','[]','{"assignee":"recovery-agent"}','{}','{}',?)`).run(f.now());
  f.store.db.prepare(`INSERT INTO collab_notes(room_id,note_id,thread_id,note_json,clock_json,id_json,created_at)
    VALUES('commons','recovery-note','recovery-thread','{"body":"synthetic fixture note"}','{}','{}',?)`).run(f.now());
  f.store.db.prepare(`INSERT INTO collab_draft_locks(room_id,lock_id,thread_id,lock_json,clock_json,id_json,expires_at,updated_at)
    VALUES('commons','recovery-lock','recovery-thread','{"holder":"recovery-agent"}','{}','{}',?,?)`).run(f.now() + 60000, f.now());
  f.store.db.prepare(`INSERT INTO collab_approvals(room_id,proposal_id,thread_id,ops_json,record_json,clock_json,id_json,status,created_at,updated_at)
    VALUES('commons','recovery-proposal','recovery-thread','[]','{"title":"synthetic fixture proposal"}','{}','{}','pending',?,?)`).run(f.now(), f.now());
  f.store.db.prepare(`INSERT INTO collab_routing_events(room_id,seq,kind,record_id,thread_id,agent_id,data_json,clock_json,id_json,created_at)
    VALUES('commons',1,'assigned','recovery-assignment','recovery-thread','recovery-agent','{}','{}','{}',?)`).run(f.now());
  const recoveryHold = f.store.spamQuarantine.quarantine({ messageId: "recovery-quarantined", channel: "telegram",
    flag: flagMessage({ body: "Urgent! Log in here to confirm your identity and claim your free airdrop. Act now!", urls: ["https://evil-claim.xyz/verify"] }) });
  // Seed one thread split so the capture covers quarantine_thread_splits.
  f.store.quarantineSplits.split({ accountId: f.owner.session.account.id, quarantineId: recoveryHold.id,
    sourceId: "recovery-source", priorThread: "recovery-thread", reviewer: f.owner.session.account.id, reason: "recovery fixture" });
  // Seed one delivered SLA-breach alert so the capture covers sla_breach_alerts.
  f.store.slaBreachAlerts.notify({ accountId: f.emailProfile.accountId,
    record: { kind: "sla_breach", urgent: true, threadId: "recovery-thread", channel: "email",
      elapsedMs: 25 * 3600 * 1000, targetMs: 24 * 3600 * 1000,
      awaitingSince: new Date(f.now() - 25 * 3600 * 1000).toISOString(),
      deadlineAt: new Date(f.now() - 3600 * 1000).toISOString(),
      producedAt: new Date(f.now()).toISOString(),
      summary: "SLA breached on email: thread recovery-thread waiting 25h (target 24h)" },
    decision: { decision: "deliver", reason: "urgent SLA breach is always delivered" },
    prefsSnapshot: createNotifyPrefs().snapshot(f.emailProfile.accountId) });
  // Seed one referral so the capture covers referrals (referral attribution).
  // The referee must be a member; the "Recovery agent" linked above works.
  f.store.referrals.record({ roomId: "commons", referrerMemberId: "owner",
    refereeMemberId: identityId, via: "invite", at: f.now() });
  // Seed one DM consent and one public-face setting so the capture
  // comparison covers dm_consents and room_public_settings.
  f.store.dmConsents.request("commons", "agent", "owner", "recovery fixture");
  f.store.dmConsents.decide("commons", "owner", "agent", "approve");
  f.store.publicFace.enable("commons", "owner");
  // Seed one directory listing so the capture comparison covers
  // room_directory_settings (opt-in public room directory #605).
  f.store.roomDirectory.set("commons", "owner", true);
  // Seed one mention row and one room mention setting so the capture
  // comparison covers mention_states and room_mention_settings (#658).
  f.store.db.prepare(`INSERT INTO mention_states(room_id,message_event_id,mentioned_member_id,state,created_at,timeout_at,decided_at)
    VALUES('commons','recovery-mention-msg','agent','delivered',?,?,NULL)`)
    .run(f.now(), f.now() + 30 * 60 * 1000);
  f.store.db.prepare(`INSERT INTO room_mention_settings(room_id,timeout_ms,updated_at)
    VALUES('commons',?,?)`)
    .run(30 * 60 * 1000, f.now());
  // Seed one row per attention table so the capture comparison covers
  // activity_events, read_horizons, saved_messages, and thread_mutes.
  f.store.db.prepare(`INSERT INTO activity_events(room_id,type,actor_id,actor_name,message_id,thread_id,user_id,created_at,read_at)
    VALUES('commons','mention','agent','Recovery agent','recovery-reported','','owner',?,NULL)`)
    .run(f.now());
  f.store.db.prepare(`INSERT INTO read_horizons(room_id,member_id,thread_id,last_read_message_id,updated_at)
    VALUES('commons','owner','','recovery-reported',?)`)
    .run(f.now());
  f.store.db.prepare(`INSERT INTO saved_messages(room_id,member_id,message_id,saved_at)
    VALUES('commons','owner','recovery-reported',?)`)
    .run(f.now());
  f.store.db.prepare(`INSERT INTO thread_mutes(room_id,member_id,thread_id,created_at)
    VALUES('commons','owner','recovery-thread',?)`)
    .run(f.now());
  // Seed one autonomy-tier row so the capture comparison covers
  // agent_autonomy_tiers (operator prerequisites rescope, PR #953).
  f.store.db.prepare(`INSERT INTO agent_autonomy_tiers(room_id,member_id,autonomy_tier,updated_at,updated_by)
    VALUES('commons','agent','t2_standard',?,'owner')
    ON CONFLICT(room_id,member_id) DO UPDATE SET autonomy_tier='t2_standard',updated_at=excluded.updated_at,updated_by='owner'`)
    .run(f.now());
  // Seed one published skill card so the capture comparison covers
  // agent_skill_cards (evidence-backed skill cards RC-2026-09-24-202).
  f.store.membersDirectory.setSkills(identityId, { publish: true,
    skills: [{ id: "recovery-skill", name: "Recovery skill", description: "Synthetic fixture skill." }] });
  // A reservation is external-execution history: capture it with the room.
  f.store.dmConsents.request("commons", "owner", "agent", "recovery fixture");
  f.store.dmConsents.decide("commons", "agent", "owner", "approve");
  f.store.command(f.keys.owner, "commons", { id: "recovery-run-request", type: T.MESSAGE_POSTED,
    data: { messageId: "recovery-run-request", toMemberId: "agent", requestKind: "reply", body: "Synthetic host recovery" } });
  const runRequest = f.store.room("commons").state.replyRequests["recovery-run-request"];
  const runInput = { requestMessageId: runRequest.id, attemptId: "recovery-host", action: "claim",
    expectedRequestRevision: runRequest.revision, contextEventId: runRequest.contextEventId };
  f.store.requestRuns.apply(f.keys.agent, "commons", runInput);
  const captureSequence = f.store.room("commons").sequence;
  // Account setup and encrypted Gmail state must be included in capture too.
  f.store.db.prepare('INSERT INTO account_setup VALUES(?,?)').run(f.owner.session.account.id, JSON.stringify({ name: 'Recovery', purpose: 'personal', platforms: ['Gmail'], step: 1, completed: false }));
  const { GmailMailbox } = await import('../server/gmail-mailbox.mjs');
  f.store.db.prepare('INSERT INTO gmail_operations VALUES(?,?,?,?,?)').run(f.emailProfile.accountId, 'recovery-operation', 'f'.repeat(64), JSON.stringify({state:'unknown'}), f.now());
  const gmail = new GmailMailbox(f.store, { tokenKey: '42'.repeat(32), clientId: 'fixture', clientSecret: 'fixture', redirectUri: 'https://room.example/api/auth/gmail/callback' });
  f.store.db.prepare('INSERT INTO gmail_linked_mailboxes VALUES(?,?,?,?)').run(f.owner.session.account.id, 'recovery-extra', f.store.account(f.owner.session.account.id).authEpoch, gmail.seal({connectionId:'recovery-extra',refreshToken:'fixture'}, f.owner.session.account.id));
  gmail.begin(f.owner.token, f.owner.session.sessionBinding);
  gmail.save(gmail.auth(f.owner.token, f.owner.session.sessionBinding), { address: 'recovery@gmail.test', connectionId: 'recovery-gmail', refreshToken: 'invented-recovery-token', syncedAt: null });
  // Seed one web-fetch cache entry and one journal row so the capture covers
  // web_fetch_cache and web_fetch_log (room-side web fetch RC-2026-09-23-102).
  // Synthetic data only.
  f.store.db.prepare(`INSERT INTO web_fetch_cache(key,url,final_url,markdown,metadata_json,bytes,fetched_at)
    VALUES('recovery-cache-key','https://example.com/','https://example.com/','# Recovery','{"title":"Recovery"}',9,?)`)
    .run(f.now());
  // web_fetch_cache_rooms (room-scoped fetch visibility, RC-2026-09-24-310
  // follow-up): the commons room fetched the recovery URL.
  f.store.db.prepare(`INSERT INTO web_fetch_cache_rooms(cache_key,room_id,fetched_at)
    VALUES('recovery-cache-key','commons',?)`)
    .run(f.now());
  f.store.db.prepare(`INSERT INTO web_fetch_log(request_id,room_id,member_id,credential_hash,host,cache_status,bytes,tags_json,created_at)
    VALUES('recovery-fetch-request','commons','agent',NULL,'example.com','miss',9,'[]',?)`)
    .run(f.now());
  // Seed one research journal row so the capture covers web_research_log
  // (knowledge router RC-2026-09-24-310). Synthetic data only; the question
  // itself is never journaled, only its hash.
  f.store.db.prepare(`INSERT INTO web_research_log(request_id,room_id,member_id,credential_hash,question_hash,sources_json,evidence_count,plan_only,created_at)
    VALUES('recovery-research-request','commons','agent',NULL,'qh-recovery','["room"]',1,0,?)`)
    .run(f.now());
  const bondAt = f.now();
  f.store.db.prepare(`INSERT INTO agent_bonds
    (id, agent_a, agent_b, state, proposed_by, proposed_scopes, accepted_scopes, note, reason, proposed_at, accepted_at, revoked_at, revoked_by, room_hint)
    VALUES ('bond-recovery','ai_recovery_a','ai_recovery_b','active','ai_recovery_a','["peer.dm"]','["peer.dm"]','','',?,NULL,NULL,NULL,'commons')`)
    .run(bondAt);
  f.store.db.prepare(`INSERT INTO peer_dm_threads (thread_id, agent_a, agent_b, bond_id, created_at)
    VALUES ('dm:ai_recovery_a:ai_recovery_b','ai_recovery_a','ai_recovery_b','bond-recovery',?)`)
    .run(bondAt);
  f.store.db.prepare(`INSERT INTO peer_dm_messages
    (message_id, thread_id, room_id, event_id, from_identity_id, to_identity_id, body, created_at)
    VALUES ('recovery-peer-dm','dm:ai_recovery_a:ai_recovery_b','commons','recovery-peer-event','ai_recovery_a','ai_recovery_b','Synthetic peer DM',?)`)
    .run(bondAt);
  // RC-2026-09-24-210: a synthetic outstanding link code (hash-only row —
  // the raw code is never stored, so the audit sees no secret material).
  f.store.db.prepare(`INSERT INTO identity_link_codes(code_hash,identity_id,created_at,expires_at,consumed_at)
    VALUES ('${"ab".repeat(32)}',?,?,?,NULL)`)
    .run(identityId, f.now(), f.now() + 600000);
  // Seed one staged inbox attachment so the capture covers inbox_attachment_bytes.
  // Written directly, like room_attachments: hosted MCP is the product writer,
  // and the audit's "every table has substantive data" check needs one row.
  const inboxBytes = Buffer.from("recovery inbox");
  f.store.db.prepare(`INSERT INTO inbox_attachment_bytes(identity_id,id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at)
    VALUES(?, 'recovery-inbox-attachment', 'recovery-inbox.txt', 'text/plain', ?, ?, ?, 'staged', ?, ?)`)
    .run(identityId, inboxBytes.length, createHash("sha256").update(inboxBytes).digest("hex"), inboxBytes, f.now(), f.now() + 1000);
  f.store.db.prepare(`INSERT INTO land_queue
    (room_id, item_id, repo, pr_number, claimant_member_id, added_by_member_id, title, head_sha,
     mergeable, behind, checks_state, observed, created_at, updated_at)
    VALUES ('commons', 'lq_recovery', 'acme/widgets', 7, 'owner', 'owner', 'Recovery PR', ?, 'unknown', 0, 'pending', 1, ?, ?)`)
    .run("a".repeat(40), f.now(), f.now());
  // telegram_live_status (durable Telegram live-delivery/send facts, task 10).
  // Synthetic data only: the recovery account received 3 updates and its last
  // send succeeded, so the capture covers the new table.
  f.store.db.prepare(`INSERT INTO telegram_live_status(account_id,connection_id,last_update_received_at,received_updates,last_send_at,last_send_outcome,last_send_code,updated_at)
    VALUES('recovery-account','recovery-connection',?,3,?,'ok','200',?)`)
    .run(f.now(), f.now(), f.now());
  const before = auditRecovery(f.store);
  assert.equal(before.rooms, 2); assert.equal(before.tables.length, 124,
    "a table was added or removed: confirm the audit covers it, then update this count"); // +3: agent_api_keys, agent_directory_cards, agent_webhook_subs (RC-2026-09-18-010); +5: stitch_* tables; +2: agent_identity_verification, room_verification_policy (RC-2026-09-18-049); +2: agent_hosts, agent_wake_signals (RC-2026-09-18-051); +1: oauth_pending_states (RC-2026-09-19); +2: dm_consents, room_public_settings (consent-bound DMs + public face, 2026-09-20); +1: room_directory_settings (opt-in public room directory #605); +2: mention_states, room_mention_settings (mention lifecycle #658); +1: membership_delegation_grants (membership delegation #761); +7: bounty_journal, bounty_records, bounty_disputes, bounty_events, bounty_idempotency, bounty_watchers, bounty_sequences (credits-only bounty exchange #762); +1: agent_key_registry (agent public-key registry, integration-map slice #9); +1: inbox_handoff_rooms (room scope for collab-route handoffs); +4: bounty_rubric_versions, bounty_flakes, bounty_review_packets, bounty_sybil_flags (bounty slices 6+8+10: pinned rubrics, anti-flake ladder, sybil detector #792); +2: guest_invites, guest_members (GX guest-invite public handoff RC-2026-09-23-100); +3: activity_events, read_horizons, saved_messages (attention: activity feed, read horizons, saved messages); +1: thread_mutes (shared: attention thread mutes + server/thread-mutes.mjs); +1: bounty_reputation_packets (slice #4: probation-gate review packets); +1: referrals (referral attribution); +2: web_fetch_cache, web_fetch_log (room-side web fetch RC-2026-09-23-102); +3: agent_bonds, peer_dm_threads, peer_dm_messages (agent Bond and peer DMs); +1: jev_shadow_decisions (Jev shadow-gate journal); +1: agent_autonomy_tiers (graduated agent autonomy tiers #928, replaces slice 1/3 agent_operator_controls); +1: agent_skill_cards (evidence-backed skill cards RC-2026-09-24-202); +1: agent_push_configs (push wake path RC-2026-09-24-203); +1: identity_link_codes (identity-holder link codes RC-2026-09-24-210); +1: inbox_attachment_bytes (identity-scoped staged inbox attachment bytes); +1: web_research_log (knowledge router RC-2026-09-24-310); +1: land_queue (pull-request land queue); +1: web_fetch_cache_rooms (room-scoped fetch visibility, RC-2026-09-24-310 follow-up); +3: referral_invite_keys, referral_invites, referral_chain_members (signed agent-carried referral invites #1025); +2: private_next_action_dismissals, private_next_action_suppressions (ranked next-actions private state RC-2026-09-25-911); +1: telegram_live_status (durable Telegram live-delivery/send facts, task #10)

  for (const table of before.tables) assert.ok(table.rows > 0, `${table.table} has substantive fixture data`);
  assert.equal(before.legacyCheckpoints, 1); assert.equal(before.replay.checkpointEvents, 2);
  const receipt = await backupRoom(f.filename, f.directory);
  assert.deepEqual(receipt.recovery, before);
  assert.equal(statSync(receipt.filename).mode & 0o777, 0o600);
  assert.equal(statSync(join(receipt.filename, "..")).mode & 0o777, 0o700);
  for (const privateValue of [f.keys.owner, f.pending.token, f.command.data.body, "recovery-target"]) assert.equal(JSON.stringify(before).includes(privateValue), false);
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
  try {
    assert.equal(recovered.requestRuns.list(f.keys.owner, "commons").runs[runRequest.id].state, "working");
    assert.throws(() => recovered.requestRuns.apply(f.keys.agent, "commons", { ...runInput, attemptId: "replacement-host" }), { code: "request_run_owned" });
    assert.deepEqual(auditRecovery(recovered), before);
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
        const state = store.room("second").state; state.room.title = "Unrecorded edit";
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
  assert.throws(() => new RoomStore(f.filename, { readOnly: true }), /requires schema v36/);
  f.store.db.exec("PRAGMA user_version=34");
  // A true v34 file carries v34 writer triggers, not v35 ones; the doctored
  // marker alone would leave the file self-inconsistent and the fence
  // (correctly) refuses it. Swap the trigger generation for the tables still
  // present (absent additive tables are skipped, per the fence's own rule) so
  // the file is self-consistent; the writable migration below reinstalls the
  // v36 set.
  const v34Tables = new Set(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  for (const row of f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'writer_v36_*'").all()) {
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
