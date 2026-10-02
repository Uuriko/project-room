// The rows the recovery audit requires. Shared with the cold-start budget so
// a wake is measured against a store that has every application table, not
// only the event log. Disposable synthetic data only.
import { createHash, randomUUID } from "node:crypto";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import { flagMessage } from "../server/inbox-spam.mjs";
import { createNotifyPrefs } from "../server/notify-prefs.mjs";
import { issueGrant } from "../server/grants.mjs";
import { appendOperatorAction } from "../server/operator-actions.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

export async function seedRecoveryCoverage(f) {
  // One append-only operator audit row. The cold-start budget and the
  // recovery audit both require every application table to hold a row,
  // except the cron tables.
  appendOperatorAction(f.store, {
    action: "purge.find", targetKind: "room", targetId: "commons",
    reason: "recovery fixture", planHash: null, counts: { rooms: 0 }, result: "found", requestId: "recovery-operator"
  });
  f.store.db.prepare("INSERT INTO share_link_codes(code_hash,link_id,created_at) VALUES(?,?,?)")
    .run(createHash("sha256").update("ABCDEFGHJ").digest("hex"), f.link.link.id, f.now());
  const { identityId } = f.store.identities.create("Recovery agent");
  // Opt-in public pages stay empty. The receipt and directory tables still
  // need a row so the recovery audit and the cold-start budget see them.
  const at = new Date(f.now()).toISOString();
  f.store.db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, hashes_json, at, start_href)
    VALUES ('pwr_recoveryfixture0000000000000001', 'Recovery receipt', 'public-work', 'commons', 'commons', 'commons', '[]', '[]', NULL, NULL, '[]', ?, 'https://room.trydemigod.com/?start=room')`).run(at);
  f.store.db.prepare(`INSERT INTO public_directory_entries
    (agent_id, name, description, skills_json, identity_id, receipt_count, room_count, updated_at)
    VALUES ('recovery-public-agent', 'Recovery agent', '', '[]', ?, 1, 1, ?)`).run(identityId, at);
  f.store.identities.link(f.keys.owner, "commons", { identityId, permissions: ["steer"] });
  f.store.invites.create(f.keys.owner, "commons", { permissions: ["steer"] });
  f.store.agentHeartbeats.heartbeat({ agentId: identityId, hostId: "recovery-work-host", mode: "pull-only", workWakes: true });
  f.store.command(f.keys.owner, "commons", { id: "recovery-work-command", type: "work.proposed", data: { workItemId: "recovery-work",
    title: "Recovery work", definitionOfDone: "Recovered", mode: "read", accountableMemberId: identityId } });
  f.store.command(f.keys.owner, "commons", { id: "recovery-work-command", type: "work.proposed", data: { workItemId: "recovery-work",
    title: "Recovery work", definitionOfDone: "Recovered", mode: "read", accountableMemberId: identityId } });
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
  f.store.delegationJournal.append("commons", identityId, "baseline_active", "legacy_unattributed", f.now(), false, true);
  f.store.db.exec("DELETE FROM membership_delegation_pending");
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
  // Seed one self-serve guest seat + its request-ID idempotency record so
  // the capture covers guest_selfserve and guest_selfserve_idem
  // (RC-2026-09-25-912). Written directly: the join path needs a signed
  // agent card the fixture has no reason to mint.
  f.store.db.prepare(`INSERT INTO guest_selfserve(member_id,room_id,key_hash,created_at,last_active_at)
    VALUES('guest-agent-selfserve','commons',?,?,?)`)
    .run("b".repeat(64), f.now(), f.now());
  f.store.db.prepare(`INSERT INTO guest_selfserve_idem(room_id,key_hash,request_id,token_hash,member_id,expires_at,renewed,created_at)
    VALUES('commons',?,'recovery-selfserve-request',?,'guest-agent-selfserve',?,0,?)`)
    .run("b".repeat(64), "c".repeat(64), f.now() + 86400000, f.now());
  // Seed the board-v2 durable registry tables (PR #1144) so the recovery
  // audit's substantive-fixture-data check covers them. Written directly:
  // the fixture has no reason to run the board-v2 claim state machine.
  f.store.db.prepare(`INSERT INTO board_vtwo_claims(task_id,lane,files,lease,lease_h,reason,state,claim_seq,claim_at,heartbeat_at,last_seq,receipts)
    VALUES('recovery-claim','recovery-lane','[]','lease=6h',6,'recovery fixture','claimed',1,?,?,0,'[]')`)
    .run(new Date(f.now()).toISOString(), new Date(f.now()).toISOString());
  f.store.db.prepare(`INSERT INTO board_vtwo_events(at,kind,task_id,lane,payload,supersedes,idempotency_key,mirror_issue,mirror_comment)
    VALUES(?, 'claim.created','recovery-claim','recovery-lane','{}',NULL,'recovery-idem-key',NULL,NULL)`)
    .run(new Date(f.now()).toISOString());
  f.store.db.prepare(`INSERT INTO board_vtwo_mirror(id,current_issue,issues) VALUES(1,266,'[266]')`).run();
  f.store.db.prepare(`INSERT INTO board_vtwo_idempotency(scoped_key,status,body,fingerprint,created_at)
    VALUES('recovery-scope',200,'{}','recovery-fingerprint',?)`)
    .run(Date.now());
  // Seed the emissary lure-generation ledgers (Slice 2, RC-2026-09-28-2873)
  // so the audit's exact-table-set check covers them: the tables are
  // created at store boot (server/store.mjs). Rows are written directly:
  // the fixture has no reason to run the lure-generation path (it would
  // mint share links), and the raw invite token is never fixture data —
  // only its hash shape.
  f.store.db.prepare(`INSERT INTO emissary_drops
    (drop_id,room_id,issuer_member_id,venue,title,terms,deadline_at,artifact_text,artifact_sha256,truncated,source,idempotency_key,created_at)
    VALUES(?, 'commons','owner','sssnack','Recovery drop','Recovery fixture terms',NULL,'Recovery drop text',?,0,'verified',NULL,?)`)
    .run(`emd1.${"ab".repeat(16)}`, "d".repeat(64), f.now());
  f.store.db.prepare(`INSERT INTO emissary_invite_attribution
    (attribution_id,room_id,issuer_member_id,invite_token_hash,note,minted_at,expires_at)
    VALUES(?, 'commons','owner',?,'recovery fixture',?,?)`)
    .run(`eia1.${"cd".repeat(16)}`, "e".repeat(64), f.now(), f.now() + 7 * 86400000);
  f.store.db.prepare(`INSERT INTO emissary_idempotency (room_id,idempotency_key,tool,result_json,created_at)
    VALUES('commons','recovery-idem-key','emissary_drop','{}',?)`)
    .run(f.now());
  f.store.db.prepare(`INSERT INTO emissary_journal (event_id,room_id,kind,actor_member_id,subject_id,details_json,created_at)
    VALUES(?,'commons','emissary.drop_generated','owner',?,'{}',?)`)
    .run(randomUUID(), `emd1.${"ab".repeat(16)}`, f.now());
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
  f.store.db.prepare(`INSERT INTO account_security_events(id,account_id,type,at)
    VALUES('recovery-security-event','recovery-account','account.password_revoked_unverified',?)`)
    .run(f.now());
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
  f.store.db.prepare(`INSERT INTO human_push_subscriptions
    (endpoint, room_id, member_id, p256dh, auth, expiration_time, created_at)
    VALUES ('https://push.example.test/recovery', 'commons', 'owner', 'recovery-p256dh', 'recovery-auth', NULL, ?)`)
    .run(f.now());
  // Seed one external identity + one receipt so the capture covers the Emissary
  // slice-1a tables (external_identities, external_receipts, RC-2026-09-27-2860).
  // register/record are the product writers; the audit's "every table has
  // substantive data" check needs one row in each.
  const recoveryExternal = f.store.emissaryGraph.register("commons", {
    kind: "agent",
    displayName: "Recovery emissary",
    venues: [{ venue: "thecolony", handle: "@recovery-emissary", proof: "self_asserted" }],
  });
  f.store.emissaryReceipts.record("commons", {
    externalId: recoveryExternal.external_id,
    offerId: null,
    kind: "work",
    payload: { synthetic: true },
  });
  // Seed one live grant edge so the capture covers agent_capability_grants
  // (per-agent capability grant edges, UFO-steal slice 1 RC-2026-09-27-2728).
  // issueGrant is the product writer; the audit's "every table has
  // substantive data" check needs one row.
  issueGrant(f.store.db, "commons", "agent", "grants:issue", { grantedBy: "owner", nowMs: f.now() });
  // Seed one owner-delegation grant + journal row so the capture covers
  // owner_delegate_grants / owner_delegate_journal (owner-delegated agent
  // authority PR #1182). Written directly: the grant product writer needs
  // a live linked identity, and the audit's "every table has substantive
  // data" check needs one row per table.
  f.store.db.prepare(`INSERT INTO owner_delegate_grants(room_id,identity_id,granted_by,granted_at,revoked_at)
    VALUES ('commons','ai_recovery_delegate','owner',?,NULL)`).run(f.now());
  f.store.db.prepare(`INSERT INTO owner_delegate_journal(room_id,identity_id,action,actor_id,recorded_at)
    VALUES ('commons','ai_recovery_delegate','grant','owner',?)`).run(f.now());
  // Capture a real external claim and immutable artifact, not empty sidecars.
  f.store.projectOffers.create("commons", "owner", { requestId: "public-recovery-create", offerId: "public-recovery", reviewerMemberIds: ["owner", "reply-reviewer"], terms: {
    kind: "task", title: "Public recovery task", summary: "Keep synthetic submitted artifact", acceptanceCriteria: ["Return recoverable bytes"],
    repositoryUrl: "https://github.com/Uuriko/project-room", reward: { kind: "unpaid" }, approvalPolicy: { mode: "human_with_agent_review" }
  } });
  f.store.projectOffers.transition("commons", "owner", "public-recovery", "publish", { requestId: "public-recovery-publish", expectedRevision: 1 });
  f.store.publicWorkClaims.enable("commons", "owner", "public-recovery", { requestId: "public-recovery-enable", expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: "main", files: ["synthetic/public-recovery.js"] });
  const publicIdentity = f.store.identities.create("Outside recovery contributor");
  const publicClaimInput = { requestId: "public-recovery-claim", expectedTermsVersion: 1, leaseHours: 1 };
  const publicClaimed = f.store.publicWorkClaims.act("public-recovery", publicIdentity.secret, "claim", publicClaimInput);
  const publicFinishInput = { requestId: "public-recovery-finish", expectedTermsVersion: 1, generation: publicClaimed.task.claim.generation,
    artifactText: "Synthetic public recovery artifact ✓", checksReported: ["Caller-reported check"] };
  const publicFinished = f.store.publicWorkClaims.act("public-recovery", publicIdentity.secret, "finish", publicFinishInput);
  const publicArtifact = f.store.publicWorkClaims.artifact(publicFinished.receipt.receiptId);
  const publicReviewTuple = { taskId: publicFinished.receipt.taskId, expectedTermsVersion: publicFinished.receipt.termsVersion,
    generation: publicFinished.receipt.generation, artifactSha256: publicFinished.receipt.artifact.sha256, reason: "Reviewed captured public bytes" };
  const publicVerifyInput = { ...publicReviewTuple, requestId: "public-recovery-verify", expectedReviewRevision: 0, verdict: "PASS" };
  const publicVerified = f.store.publicWorkReviews.verify("commons", "reply-reviewer", publicFinished.receipt.receiptId, publicVerifyInput);
  const publicReviewInput = { ...publicReviewTuple, requestId: "public-recovery-accept", expectedReviewRevision: 1, decision: "accepted" };
  const publicReviewed = f.store.publicWorkReviews.decide("commons", "owner", publicFinished.receipt.receiptId, publicReviewInput);
  // Populate both follow-up tables through the real owner/domain path so
  // backup coverage cannot pass by merely listing two empty sidecars.
  const followTerms = { kind: "task", title: "Recover the explicit revision", summary: "Owner-authored public recovery scope",
    acceptanceCriteria: ["Return revised bytes"], repositoryUrl: "https://github.com/Uuriko/project-room", reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" } };
  f.store.projectOffers.create("commons", "owner", { requestId: "follow-parent-create", offerId: "follow-parent", reviewerMemberIds: ["owner"], terms: followTerms });
  f.store.projectOffers.transition("commons", "owner", "follow-parent", "publish", { requestId: "follow-parent-publish", expectedRevision: 1 });
  f.store.publicWorkClaims.enable("commons", "owner", "follow-parent", { requestId: "follow-parent-enable", expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: "main", files: ["synthetic/revised.txt"] });
  f.store.publicWorkClaims.act("follow-parent", publicIdentity.secret, "claim", { requestId: "follow-parent-claim", expectedTermsVersion: 1 });
  const followReceipt = f.store.publicWorkClaims.act("follow-parent", publicIdentity.secret, "finish", { requestId: "follow-parent-finish", expectedTermsVersion: 1, generation: 1, artifactText: "Original revision bytes", checksReported: [] }).receipt;
  const followRevision = f.store.publicWorkReviews.decide("commons", "owner", followReceipt.receiptId, { requestId: "follow-parent-revision", expectedReviewRevision: 0,
    taskId: "follow-parent", expectedTermsVersion: 1, generation: 1, artifactSha256: followReceipt.artifact.sha256, decision: "revision_requested", reason: "Private recovered revision feedback" });
  const followInput = { requestId: "recovery-create-follow-up", expectedReviewRevision: followRevision.review.revision, taskId: "follow-parent", expectedTermsVersion: 1,
    generation: 1, artifactSha256: followReceipt.artifact.sha256, successorTaskId: "follow-child", terms: { ...followTerms, title: "Explicit new recovery task" }, repositoryRef: "main", files: ["synthetic/revised.txt"] };
  const followResult = f.store.publicWorkSuccessors.create("commons", "owner", followReceipt.receiptId, followInput);
  // Seed terms acceptance, one public report, and one unpublish. The recovery
  // audit and the cold-start budget require a row in every application table.
  // The unpublish target is not a room in this fixture.
  const termsAccount = f.store.db.prepare("SELECT id FROM accounts LIMIT 1").get();
  f.store.db.prepare("INSERT INTO account_terms (account_id, terms_version, accepted_at) VALUES (?, ?, ?)")
    .run(termsAccount.id, "2026-10-02", f.now());
  f.store.db.prepare(`INSERT INTO public_abuse_reports (id, kind, target, body, email, ip_hash, created_at, status)
    VALUES ('rpt_recovery', 'room', 'recovery-public-room', 'Seeded so the capture covers public abuse reports.', NULL, ?, ?, 'open')`)
    .run(createHash("sha256").update("project-room-public-report:recovery").digest("hex"), f.now());
  f.store.db.prepare("INSERT INTO public_unpublish (kind, target, at, by_account) VALUES ('room', 'recovery-public-room', ?, ?)")
    .run(f.now(), termsAccount.id);

  return {
    runRequest, runInput, offerRecords: f.store.projectOffers.ownerList("commons", "owner"),
    publicIdentity, publicClaimInput, publicClaimed, publicFinishInput, publicFinished,
    publicArtifact, publicVerifyInput, publicVerified, publicReviewInput, publicReviewed,
    publicReviewRows: f.store.db.prepare("SELECT * FROM public_work_reviews ORDER BY receipt_id").all(),
    publicReviewJournal: f.store.db.prepare("SELECT * FROM public_work_review_requests ORDER BY request_id").all(),
    followRows: f.store.db.prepare("SELECT * FROM public_work_successors ORDER BY parent_receipt_id").all(),
    followJournal: f.store.db.prepare("SELECT * FROM public_work_successor_requests ORDER BY request_id").all(),
    followReceipt, followInput, followResult, captureSequence
  };
}
