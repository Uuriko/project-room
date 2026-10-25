// IR-1: reconcileRestoredAuthority covers the whole capability graph.
//
// The capability-graph census (tests/fixtures/capability-graph.json —
// the DEEP-SCAN CAPABILITY-GRAPH snapshot at 2feda87c7) derived 25
// DB-resident capability classes that a whole-DB restore resurrects
// while the reconciliation named none of them. This suite is the
// acceptance for closing that set:
//
//   1. a completeness guard — every resurrect-and-blind class in the
//      census has a check kind in RECONCILE_CLASS_KINDS, and every
//      kind is a census class or a named legacy kind;
//   2. a per-class matrix, GENERATED from the census node list — plant
//      the authority, back up, withdraw it in the live store, restore,
//      and require a stale entry of that class's kind. A class with no
//      plant fails the suite: the matrix cannot skip silently;
//   3. the two executed repros that proved the defect (CAPABILITY-GRAPH
//      Fixture A and SECURITY-2ND-ORDER C-D), re-asserted positively;
//   4. the quiet case — a backup taken after the mutations reconciles
//      clean (no false positives, both-direction checks included);
//   5. A5 (share-link join consumption) and A7 (revoked-key refusal
//      reason) riders.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { backupRoom, reconcileRestoredAuthority, RECONCILE_CLASS_KINDS } from "../server/backup.mjs";
import { ensureOAuthProviderSchema } from "../server/oauth-provider-store.mjs";
import { generateEd25519KeyPair } from "../server/agent-key-registry.mjs";
import { issueSpendGrant, revokeSpendGrant } from "../server/spend-grants.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { issueSignedEvidence, verifySignedEvidence, contentHashOf } from "../server/signed-evidence.mjs";

const graph = JSON.parse(readFileSync(new URL("./fixtures/capability-graph.json", import.meta.url), "utf8"));
const blindKinds = graph.nodes.filter(n => n.restore_resurrects && !n.reconcile_named).map(n => n.id);
const LEGACY_KINDS = ["credential", "share_link", "agent_connection", "account", "membership_delegation", "member"];

function boot(t) {
  const dir = mkdtempSync(join(tmpdir(), "ir1-matrix-"));
  const dest = mkdtempSync(join(tmpdir(), "ir1-backup-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true }); });
  const filename = join(dir, "room.sqlite");
  const store = new RoomStore(filename);
  store.initialize(initialRoom("commons"));
  ensureOAuthProviderSchema(store.db);
  const owner = store.issueAccessKey("commons", "owner");
  const ownerMemberId = store.room("commons").state.room.ownerId;
  const accountId = store.db.prepare("SELECT id FROM accounts ORDER BY id LIMIT 1").get().id;
  return { store, filename, dest, owner, ownerMemberId, accountId };
}

const memberIdOf = (store, identityId) =>
  Object.values(store.room("commons").state.members).find(m => m.identityId === identityId)?.id;

async function backupAndRestore(ctx) {
  const result = await backupRoom(ctx.filename, ctx.dest);
  return new RoomStore(result.filename, { readOnly: false });
}

test("completeness guard: census classes and reconcile kinds correspond", () => {
  assert.equal(blindKinds.length, 25, "census snapshot carries the 25 resurrect-and-blind classes");
  for (const id of blindKinds) {
    assert.ok(RECONCILE_CLASS_KINDS.includes(id), `graph class ${id} resurrects on restore but has no reconcile check`);
  }
  const graphIds = new Set(graph.nodes.map(n => n.id));
  for (const kind of RECONCILE_CLASS_KINDS) {
    assert.ok(graphIds.has(kind) || LEGACY_KINDS.includes(kind), `reconcile kind ${kind} is neither a census class nor a legacy kind`);
  }
  assert.equal(new Set(RECONCILE_CLASS_KINDS).size, RECONCILE_CLASS_KINDS.length, "no duplicate reconcile kinds");
});

// ---------------------------------------------------------------------------
// Per-class matrix. Plants use the modules' own APIs where the proving
// repros established an idiom; the rest plant schema-true rows by SQL and
// withdraw them with the same UPDATE/DELETE shape the owning module uses
// (each such case is commented). The reconcile is a table comparator —
// the matrix exercises exactly its contract, class by class.
// ---------------------------------------------------------------------------
const NOW = () => Date.now();
const PLANTS = {
  identity_secret: {
    plant() {},
    // agent-identities.mjs revoke() stamps revoked_at.
    withdraw(ctx, X) { ctx.store.identities.revoke(X.identityId, X.secret); },
  },
  rotation_receipt: {
    // rotate()/revoke() DELETE the identity's receipt rows
    // (agent-identities.mjs:963,1047,1078) — presence is the state.
    plant(ctx, X) {
      ctx.store.db.prepare(`INSERT INTO agent_identity_rotation_receipts
        (identity_id, request_id, pre_hash, pre_fallback_hash, pre_legacy_hash, created_at)
        VALUES(?,?,?,?,?,?)`).run(X.identityId, "mx-receipt-1", "pre-hash", null, null, NOW());
    },
    withdraw(ctx, X) {
      ctx.store.db.prepare("DELETE FROM agent_identity_rotation_receipts WHERE identity_id=? AND request_id=?")
        .run(X.identityId, "mx-receipt-1");
    },
  },
  claim_key: {
    plant(ctx, X) {
      const kp = generateEd25519KeyPair();
      ctx.store.keyRegistry.registerKey(X.identityId, kp.publicKey);
      return { publicKey: kp.publicKey };
    },
    withdraw(ctx, X, memberId, planted) {
      ctx.store.keyRegistry.revokeKey(X.identityId, { identitySecret: X.secret, publicKey: planted.publicKey });
    },
  },
  link_code: {
    plant(ctx, X) {
      const { linkCode } = ctx.store.identities.mintLinkCode(X.identityId, X.secret);
      return { linkCode };
    },
    withdraw(ctx, X, memberId, planted) { ctx.store.identities.consumeLinkCode(X.identityId, planted.linkCode); },
  },
  approved_access_row: {
    plant(ctx, X) {
      ctx.store.db.prepare(`INSERT INTO access_requests
        (request_id, room_id, identity_id, display_name, requested_permissions, status, created_at, decided_at, decided_by)
        VALUES(?,?,?,?,?,?,?,?,?)`).run("mx-access-1", "commons", X.identityId, "Matrix", "[]", "approved", NOW(), NOW(), "owner");
    },
    // The module's own terminal transition for a decided row
    // (access-requests.mjs:789 stamps status='expired').
    withdraw(ctx) { ctx.store.db.prepare("UPDATE access_requests SET status='expired' WHERE request_id='mx-access-1'").run(); },
  },
  owner_delegate_grant: {
    plant(ctx, X) { ctx.store.ownerDelegates.grant(ctx.owner, "commons", { identityId: X.identityId }); },
    withdraw(ctx, X) { ctx.store.ownerDelegates.revoke(ctx.owner, "commons", { identityId: X.identityId }); },
  },
  capability_grant: {
    plant(ctx, X, memberId) {
      issueSpendGrant(ctx.store.db, "commons", memberId, { grantedBy: ctx.ownerMemberId, capCents: "5000", perTxCapCents: "1000" });
    },
    withdraw(ctx, X, memberId) { revokeSpendGrant(ctx.store.db, "commons", memberId); },
  },
  spend_terms: {
    plant(ctx, X, memberId) {
      issueSpendGrant(ctx.store.db, "commons", memberId, { grantedBy: ctx.ownerMemberId, capCents: "5000", perTxCapCents: "1000" });
    },
    // Terms carry no revocation flag: the owner tightens them by
    // re-issuing. A restore rewinds the row to the backup's caps.
    withdraw(ctx, X, memberId) {
      issueSpendGrant(ctx.store.db, "commons", memberId, { grantedBy: ctx.ownerMemberId, capCents: "500", perTxCapCents: "100" });
    },
  },
  rak_key: {
    plant(ctx, X) {
      const issued = ctx.store.agentPlugin.issueApiKey({ identityId: X.identityId, scopes: ["rooms:read", "rooms:write"] });
      return { keyId: issued.keyId };
    },
    withdraw(ctx, X, memberId, planted) { ctx.store.agentPlugin.revokeApiKey({ identityId: X.identityId, keyId: planted.keyId }); },
  },
  onboarding_token: {
    plant(ctx, X) {
      const token = ctx.store.agentPlugin.issueOnboardingMcpToken({ identityId: X.identityId, roomId: "commons", label: "matrix" });
      return { keyId: token.keyId };
    },
    withdraw(ctx, X, memberId, planted) { ctx.store.agentPlugin.revokeApiKey({ identityId: X.identityId, keyId: planted.keyId }); },
  },
  agent_invite_code: {
    plant(ctx) {
      ctx.store.db.prepare(`INSERT INTO agent_invite_codes
        (code_hash, room_id, created_by, permissions_json, display_name, created_at, expires_at, redeemed_at, redeemed_identity_id, revoked_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run("a".repeat(64), "commons", "owner", "[]", null, NOW(), NOW() + 3600000, null, null, null);
    },
    // agent-invites.mjs revoke stamps revoked_at.
    withdraw(ctx) { ctx.store.db.prepare("UPDATE agent_invite_codes SET revoked_at=? WHERE code_hash=?").run(NOW(), "a".repeat(64)); },
  },
  guest_invite: {
    plant(ctx) {
      ctx.store.db.prepare(`INSERT INTO guest_invites
        (id, code_hash, room_id, tier, credential_ttl_ms, guest_label, minted_by_member_id, minted_by_account_id,
         issue_request_id, created_at, redeem_by, status, redeemed_at, redeemed_by_identity_id, redeemed_member_id, revoked_at, revoked_by_member_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run("mx-guest-1", "b".repeat(64), "commons", "observer", 3600000, "Matrix guest", "owner", null,
          "mx-guest-req", NOW(), NOW() + 3600000, "active", null, null, null, null, null);
    },
    withdraw(ctx) {
      ctx.store.db.prepare("UPDATE guest_invites SET status='revoked', revoked_at=?, revoked_by_member_id='owner' WHERE id='mx-guest-1'").run(NOW());
    },
  },
  referral_token: {
    plant(ctx) {
      ctx.store.db.prepare(`INSERT INTO referral_invites
        (jti, room_id, chain_id, inviter_member_id, depth, max_depth, created_at, expires_at, status, rejected_at, reject_reason, redeemed_at, redeemed_member_id, redeemed_identity_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("mx-ref-1", "commons", "mx-chain", "owner", 0, 3, NOW(), NOW() + 604800000, "minted", null, null, null, null, null);
    },
    withdraw(ctx) {
      ctx.store.db.prepare("UPDATE referral_invites SET status='rejected', rejected_at=?, reject_reason='matrix' WHERE jti='mx-ref-1'").run(NOW());
    },
  },
  attestation: {
    plant(ctx, X) { ctx.store.agentPlugin.verifyIdentity({ identityId: X.identityId, verifiedBy: "owner" }); },
    withdraw(ctx, X) { ctx.store.agentPlugin.unverifyIdentity({ identityId: X.identityId }); },
  },
  directory_card: {
    plant(ctx, X) {
      ctx.store.db.prepare(`INSERT INTO agent_directory_cards
        (agent_id, card_json, visibility, owner_identity_id, published_at, updated_at, withdrawn)
        VALUES(?,?,?,?,?,?,0)`).run(X.identityId, JSON.stringify({ name: "Matrix" }), "public", X.identityId, NOW(), NOW());
    },
    withdraw(ctx, X) { ctx.store.db.prepare("UPDATE agent_directory_cards SET withdrawn=1 WHERE agent_id=?").run(X.identityId); },
  },
  webhook_subscription: {
    plant(ctx, X) {
      ctx.store.db.prepare(`INSERT INTO agent_webhook_subs
        (subscription_id, agent_id, url, events_json, secret, enabled, created_at)
        VALUES(?,?,?,?,?,1,?)`).run("mx-sub-1", X.identityId, "https://example.invalid/hook", "[]", "matrix-secret", NOW());
    },
    withdraw(ctx) { ctx.store.db.prepare("UPDATE agent_webhook_subs SET enabled=0 WHERE subscription_id='mx-sub-1'").run(); },
  },
  push_config: {
    plant(ctx, X) {
      ctx.store.db.prepare(`INSERT INTO agent_push_configs
        (agent_id, host_id, push_url, push_token, updated_at) VALUES(?,?,?,?,?)`)
        .run(X.identityId, "mx-host", "https://example.invalid/push", "matrix-token", NOW());
    },
    // Removing a push config deletes the row (no tombstone column).
    withdraw(ctx, X) { ctx.store.db.prepare("DELETE FROM agent_push_configs WHERE agent_id=? AND host_id='mx-host'").run(X.identityId); },
  },
  autonomy_tier: {
    plant(ctx, X, memberId) { setTier(ctx.store.db, "commons", memberId, "t2_standard", { updatedBy: ctx.ownerMemberId }); },
    withdraw(ctx, X, memberId) { setTier(ctx.store.db, "commons", memberId, "t1_readonly", { updatedBy: ctx.ownerMemberId }); },
  },
  membership_invitation: {
    // Issued through the real path: the store verifies invitation
    // records (fingerprint + journal) when it opens a database, so a
    // fabricated row fails backupRoom's audit before the matrix starts.
    plant(ctx) {
      const ownerAccountId = ctx.store.authenticate(ctx.owner).account.id;
      const accessKey = ctx.store.issueAccountAccessKey(ownerAccountId);
      const slot = ctx.store.createAccountSessionSlot();
      const login = ctx.store.loginAccountSession(slot.token, accessKey, slot.session.sessionRevision);
      ctx.store.createAccount("mx-invitee");
      const issued = ctx.store.issueInvitation(slot.token, "commons", {
        requestId: "mx-inv-req", token: randomBytes(32).toString("base64url"),
        intendedAccountId: "mx-invitee", intendedMemberId: "mx-member",
        displayName: "Matrix Member", role: "member", expiresAt: NOW() + 3600000,
        expectedIssuerMemberRevision: ctx.store.room("commons").state.members.owner.revision,
        expectedSessionBinding: login.sessionBinding,
      });
      return { id: issued.invitation.id };
    },
    // Revocation stamps exactly the fields the state machine's CHECK
    // requires (status/revision/revoked_*); the issuance fingerprint
    // does not cover them.
    withdraw(ctx, X, memberId, planted) {
      ctx.store.db.prepare(`UPDATE membership_invitations
        SET status='revoked', revision=1, revoked_at=?, revoked_by_member_id='owner', revoke_reason='matrix' WHERE id=?`)
        .run(NOW(), planted.id);
    },
  },
  oauth_client: {
    plant(ctx) {
      ctx.store.db.prepare(`INSERT INTO oauth_provider_clients (client_id, name, redirect_uris_json, expires_at)
        VALUES(?,?,?,?)`).run("mx-client", "Matrix Client", "[]", NOW() + 86400000);
    },
    // Deregistration deletes the row (no revocation flag exists).
    withdraw(ctx) { ctx.store.db.prepare("DELETE FROM oauth_provider_clients WHERE client_id='mx-client'").run(); },
  },
  oauth_code: {
    plant(ctx) {
      ctx.store.db.prepare(`INSERT INTO oauth_provider_codes
        (code_hash, client_id, user_id, redirect_uri, scopes_json, code_challenge, created_at, expires_at, used, family_id)
        VALUES(?,?,?,?,?,?,?,?,0,?)`).run("e".repeat(64), "mx-client", "mx-user", "https://example.invalid/cb", "[]", "challenge", NOW(), NOW() + 600000, "mx-family");
    },
    withdraw(ctx) { ctx.store.db.prepare("UPDATE oauth_provider_codes SET used=1 WHERE code_hash=?").run("e".repeat(64)); },
  },
  oauth_access: {
    plant(ctx) {
      ctx.store.db.prepare(`INSERT INTO oauth_provider_access_tokens
        (token_hash, client_id, user_id, scopes_json, family_id, created_at, expires_at, revoked)
        VALUES(?,?,?,?,?,?,?,0)`).run("f".repeat(64), "mx-client", "mx-user", "[]", "mx-family", NOW(), NOW() + 3600000);
    },
    withdraw(ctx) { ctx.store.db.prepare("UPDATE oauth_provider_access_tokens SET revoked=1 WHERE token_hash=?").run("f".repeat(64)); },
  },
  oauth_refresh: {
    plant(ctx) {
      ctx.store.db.prepare(`INSERT INTO oauth_provider_refresh_tokens
        (token_hash, client_id, user_id, scopes_json, family_id, created_at, expires_at, revoked, rotated_by)
        VALUES(?,?,?,?,?,?,?,0,NULL)`).run("9".repeat(64), "mx-client", "mx-user", "[]", "mx-family", NOW(), NOW() + 86400000);
    },
    // Rotation retires the presented token by stamping rotated_by.
    withdraw(ctx) { ctx.store.db.prepare("UPDATE oauth_provider_refresh_tokens SET rotated_by='mx-successor' WHERE token_hash=?").run("9".repeat(64)); },
  },
  login_method: {
    plant(ctx) {
      ctx.store.db.prepare(`INSERT INTO account_login_methods
        (id, account_id, type, provider, label, email, created_at, disabled)
        VALUES(?,?,?,?,?,?,?,0)`).run("mx-method-1", ctx.accountId, "password", null, "Password", null, NOW());
    },
    withdraw(ctx) { ctx.store.db.prepare("UPDATE account_login_methods SET disabled=1 WHERE id='mx-method-1'").run(); },
  },
  stitch_link: {
    plant(ctx) {
      ctx.store.db.prepare(`INSERT INTO stitch_links
        (account_id, stitch_key, channel, source_id, linked_at, link_rule, link_score)
        VALUES(?,?,?,?,?,?,?)`).run(ctx.accountId, `v1:${"a".repeat(64)}`, "email", "mx-source", new Date().toISOString(), "matrix", 1);
    },
    withdraw(ctx) {
      ctx.store.db.prepare(`INSERT INTO stitch_revocations
        (account_id, stitch_key, channel, source_id, reason, revoked_at) VALUES(?,?,?,?,?,?)`)
        .run(ctx.accountId, `v1:${"a".repeat(64)}`, "email", "mx-source", "matrix", NOW());
    },
  },
};

test("matrix covers exactly the census blind set", () => {
  assert.deepEqual(Object.keys(PLANTS).sort(), [...blindKinds].sort(),
    "a census class with no matrix plant (or a plant for a non-blind class) fails here");
});

for (const kind of blindKinds) {
  test(`matrix: ${kind} withdrawn after the backup is named on restore`, async (t) => {
    const ctx = boot(t);
    const X = ctx.store.identities.create(`Matrix ${kind}`);
    ctx.store.identities.link(ctx.owner, "commons", { identityId: X.identityId, permissions: ["accept_work"] });
    const memberId = memberIdOf(ctx.store, X.identityId);
    const planted = await PLANTS[kind].plant(ctx, X, memberId);
    const restored = await backupAndRestore(ctx);
    t.after(() => restored.close());
    await PLANTS[kind].withdraw(ctx, X, memberId, planted);
    const report = reconcileRestoredAuthority(restored, ctx.store);
    assert.ok(report.stale.some(row => row.kind === kind),
      `expected a stale entry of kind ${kind}; got ${JSON.stringify(report.stale)}`);
    ctx.store.close();
  });
}

// ---------------------------------------------------------------------------
// Executed-repro anchors: the two fixtures that proved the defect,
// re-asserted positively against the extended reconciliation.
// ---------------------------------------------------------------------------

test("Fixture A anchor: spend grant, claim key and tier demotion are named; delegation control names exactly one", async (t) => {
  const ctx = boot(t);
  const X = ctx.store.identities.create("Graph Agent A");
  ctx.store.identities.link(ctx.owner, "commons", { identityId: X.identityId, permissions: ["accept_work"] });
  const memberId = memberIdOf(ctx.store, X.identityId);
  ctx.store.delegation.grant(ctx.owner, "commons", { identityId: X.identityId });
  issueSpendGrant(ctx.store.db, "commons", memberId, { grantedBy: ctx.ownerMemberId, capCents: "5000", perTxCapCents: "1000" });
  const kp = generateEd25519KeyPair();
  ctx.store.keyRegistry.registerKey(X.identityId, kp.publicKey);

  const restored = await backupAndRestore(ctx);
  t.after(() => restored.close());

  ctx.store.delegation.revoke(ctx.owner, "commons", { identityId: X.identityId });
  revokeSpendGrant(ctx.store.db, "commons", memberId);
  ctx.store.keyRegistry.revokeKey(X.identityId, { identitySecret: X.secret, publicKey: kp.publicKey });
  setTier(ctx.store.db, "commons", memberId, "t1_readonly", { updatedBy: ctx.ownerMemberId });

  const report = reconcileRestoredAuthority(restored, ctx.store);
  const kinds = report.stale.map(row => row.kind);
  assert.equal(kinds.filter(k => k === "membership_delegation").length, 1, "control names exactly its entry");
  assert.ok(kinds.includes("capability_grant"), `spend edge named; got ${JSON.stringify(report.stale)}`);
  assert.ok(kinds.includes("claim_key"), `claim key named; got ${JSON.stringify(report.stale)}`);
  assert.ok(kinds.includes("autonomy_tier"), `tier demotion named; got ${JSON.stringify(report.stale)}`);
  // Revoking a spend grant stamps the edge only — the terms row is
  // identical in both stores, so spend_terms correctly stays silent here;
  // the terms class fires on the re-issue shape (matrix, above).
  assert.ok(!kinds.includes("spend_terms"), "terms unchanged by an edge revoke: no spend_terms entry");
  // The report's per-class counts come from the same class table.
  for (const kind of RECONCILE_CLASS_KINDS) {
    assert.equal(typeof report.checkedClasses[kind], "number", `checkedClasses carries ${kind}`);
  }
  assert.ok(report.checkedClasses.capability_grant >= 1);
  for (const key of ["credentials", "shareLinks", "agentConnections", "accounts", "membershipDelegations", "rooms"]) {
    assert.equal(typeof report.checked[key], "number", `legacy checked.${key} still reported`);
  }
  ctx.store.close();
});

test("C-D anchor: all five planted classes are named (was: one of five)", async (t) => {
  const ctx = boot(t);
  const X = ctx.store.identities.create("Restore Agent");
  ctx.store.identities.link(ctx.owner, "commons", { identityId: X.identityId, permissions: ["accept_work", "steer"] });
  ctx.store.delegation.grant(ctx.owner, "commons", { identityId: X.identityId });
  ctx.store.ownerDelegates.grant(ctx.owner, "commons", { identityId: X.identityId });
  const issued = ctx.store.agentPlugin.issueApiKey({
    identityId: X.identityId, scopes: ["mcp:room:commons", "rooms:read", "rooms:write"],
  });
  ctx.store.agentPlugin.verifyIdentity({ identityId: X.identityId, verifiedBy: "owner" });
  const W = ctx.store.identities.create("Code Holder");
  const { linkCode } = ctx.store.identities.mintLinkCode(W.identityId, W.secret);

  const restored = await backupAndRestore(ctx);
  t.after(() => restored.close());

  ctx.store.delegation.revoke(ctx.owner, "commons", { identityId: X.identityId });
  ctx.store.ownerDelegates.revoke(ctx.owner, "commons", { identityId: X.identityId });
  ctx.store.agentPlugin.revokeApiKey({ identityId: X.identityId, keyId: issued.keyId });
  ctx.store.agentPlugin.unverifyIdentity({ identityId: X.identityId });
  ctx.store.identities.consumeLinkCode(W.identityId, linkCode);
  // Timestamp hygiene for the divergence rule below: the scenario's
  // timeline has the live spend and the restored re-spend well apart,
  // but two adjacent calls can land in the same millisecond — and
  // identical timestamps are the faithful-copy case the check must
  // pass. Age the live consumption so the restored copy's re-spend is
  // strictly later, deterministically.
  ctx.store.db.prepare("UPDATE identity_link_codes SET consumed_at = consumed_at - 60000 WHERE identity_id=? AND consumed_at IS NOT NULL")
    .run(W.identityId);
  // The original repro proves the re-spend in the restored store BEFORE
  // reconciling; the reconcile must still name the code (its restored
  // consumption timestamp cannot be the live store's consumption).
  restored.identities.consumeLinkCode(W.identityId, linkCode);

  const report = reconcileRestoredAuthority(restored, ctx.store);
  const kinds = new Set(report.stale.map(row => row.kind));
  for (const kind of ["membership_delegation", "owner_delegate_grant", "rak_key", "attestation", "link_code"]) {
    assert.ok(kinds.has(kind), `${kind} named; got ${JSON.stringify(report.stale)}`);
  }
  ctx.store.close();
});

test("quiet restore: a backup taken after the mutations reconciles clean", async (t) => {
  const ctx = boot(t);
  const X = ctx.store.identities.create("Quiet Agent");
  ctx.store.identities.link(ctx.owner, "commons", { identityId: X.identityId, permissions: ["accept_work"] });
  const memberId = memberIdOf(ctx.store, X.identityId);
  // A spread of classes, including the two-direction login-binding check
  // and an explicit tier row, all in their final state BEFORE the backup.
  ctx.store.delegation.grant(ctx.owner, "commons", { identityId: X.identityId });
  issueSpendGrant(ctx.store.db, "commons", memberId, { grantedBy: ctx.ownerMemberId, capCents: "5000", perTxCapCents: "1000" });
  const kp = generateEd25519KeyPair();
  ctx.store.keyRegistry.registerKey(X.identityId, kp.publicKey);
  ctx.store.agentPlugin.verifyIdentity({ identityId: X.identityId, verifiedBy: "owner" });
  setTier(ctx.store.db, "commons", memberId, "t1_readonly", { updatedBy: ctx.ownerMemberId });
  await PLANTS.login_method.plant(ctx, X, memberId);
  await PLANTS.oauth_access.plant(ctx, X, memberId);

  const restored = await backupAndRestore(ctx);
  t.after(() => restored.close());
  const report = reconcileRestoredAuthority(restored, ctx.store);
  assert.deepEqual(report.stale, [], `no stale authority in a post-mutation backup; got ${JSON.stringify(report.stale)}`);
  ctx.store.close();
});

test("login_method: a binding added after the backup is named as erased by the restore", async (t) => {
  const ctx = boot(t);
  const restored = await backupAndRestore(ctx);
  t.after(() => restored.close());
  await PLANTS.login_method.plant(ctx, {}, memberIdOf(ctx.store, ctx.store.room("commons").state.room.ownerId));
  const report = reconcileRestoredAuthority(restored, ctx.store);
  assert.ok(report.stale.some(row => row.kind === "login_method" && /bound after the backup/.test(row.detail)),
    `expected the erased-binding entry; got ${JSON.stringify(report.stale)}`);
  ctx.store.close();
});

// ---------------------------------------------------------------------------
// A5: share-link reconciliation compares join consumption, not just
// revoked_at. Real stores throughout: a link minted before the backup,
// two joins recorded after it.
// ---------------------------------------------------------------------------
test("A5: joins spent after the backup regain their slots, named", async (t) => {
  const ctx = boot(t);
  const ownerRevision = ctx.store.room("commons").state.members.owner.revision;
  const link = ctx.store.shareLinks.create(ctx.owner, "commons", {
    requestId: randomUUID(), linkToken: randomBytes(32).toString("base64url"),
    expiresAt: NOW() + 3600000, maxJoins: 10, expectedMemberRevision: ownerRevision,
  }, null).link;
  const restored = await backupAndRestore(ctx);
  t.after(() => restored.close());
  // Two joins land after the backup. The redemption path records a join
  // as a share_link_joins row, and the reconcile reads row counts only —
  // the fixture inserts the rows directly, with FK enforcement relaxed
  // on this handle for the insert (the FK parents sit outside the
  // reconcile's contract).
  ctx.store.db.exec("PRAGMA foreign_keys=OFF");
  for (let i = 0; i < 2; i++) {
    ctx.store.db.prepare("INSERT INTO share_link_joins (link_id, invitation_id, slot_hash, redemption_id, session_revision, fingerprint) VALUES (?,?,?,?,0,?)")
      .run(link.id, `a5-inv-${i}`, `a5-slot-${i}`, `a5-red-${i}`, `a5-fp-${i}`);
  }
  ctx.store.db.exec("PRAGMA foreign_keys=ON");
  const report = reconcileRestoredAuthority(restored, ctx.store);
  const entries = report.stale.filter(row => row.kind === "share_link");
  assert.equal(entries.length, 1, `exactly the join-consumption entry; got ${JSON.stringify(report.stale)}`);
  assert.match(entries[0].detail, /regains 2 join\(s\) spent after the backup/);
  assert.equal(report.checked.shareLinks, 1);
  ctx.store.close();
});

// ---------------------------------------------------------------------------
// A7: the claim-key refusal reason. With a second in-window key present,
// evidence signed by a revoked key used to be refused as bad_signature —
// the candidate-set loop never reached the revoked branch. The refusal
// was correct; its reason masked the revocation.
// ---------------------------------------------------------------------------
test("A7: evidence signed by a revoked key is refused as revoked_key, not bad_signature", (t) => {
  const ctx = boot(t);
  const X = ctx.store.identities.create("Signer");
  const live = generateEd25519KeyPair();
  const dead = generateEd25519KeyPair();
  ctx.store.keyRegistry.registerKey(X.identityId, live.publicKey);
  ctx.store.keyRegistry.registerKey(X.identityId, dead.publicKey);
  ctx.store.keyRegistry.revokeKey(X.identityId, { identitySecret: X.secret, publicKey: dead.publicKey });
  const seedHexOf = kp => Buffer.from(kp.privateKey, "base64").toString("hex");
  const signAt = (kp, ms) => issueSignedEvidence({ signerIdentityId: X.identityId,
    issuedAt: new Date(ms).toISOString(), contentHash: contentHashOf("attested work"), seedHex: seedHexOf(kp) });

  const refused = verifySignedEvidence(signAt(dead, Date.now() + 5000), { registry: ctx.store.keyRegistry });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "revoked_key", `revocation is named (A7 masking fixed); got ${JSON.stringify(refused)}`);

  const accepted = verifySignedEvidence(signAt(live, Date.now() + 5000), { registry: ctx.store.keyRegistry });
  assert.equal(accepted.ok, true, "the live key still verifies");

  const tampered = { ...signAt(live, Date.now() + 5000), contentHash: contentHashOf("different work") };
  const badSig = verifySignedEvidence(tampered, { registry: ctx.store.keyRegistry });
  assert.equal(badSig.ok, false);
  assert.equal(badSig.code, "bad_signature", "genuine signature failures keep their reason");
  ctx.store.close();
});
