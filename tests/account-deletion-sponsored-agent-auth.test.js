// WAVE-500 guild 1 (auth & sign-in) worker 12/50 — deleted-member integrity.
//
// BUG: account deletion disconnects agents the account sponsored by
// revoking their room credentials (agentConnections.revokeAccount), but a
// sponsored agent that authenticates through its agent identity secret
// keeps room access after the sponsor's account is deleted. revokeAccount
// only flips credentials.revoked; the identity_links row survives, and
// resolveIdentityLink only checks the projection member's active flag —
// which account deletion never clears for the sponsored member. Compare
// agent-connections.mjs disconnect: it revokes the credential AND removes
// the identity link AND deactivates the member. The account-deletion
// "sponsored_agents" step does only the first.
//
// Fail-first: before the fix, the final authenticate() succeeds (the
// sponsored agent still authenticates with its identity secret after its
// sponsor's account is deleted). After the fix it must 401.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { planAccountDeletion, executeAccountDeletion } from "../server/account-deletion.mjs";

const sha256hex = text => createHash("sha256").update(text).digest("hex");

function setup(t) {
  const store = new RoomStore(":memory:", { now: () => Date.now() });
  store.initialize(initialRoom());
  t.after(() => store.close());
  const A = "u-sponsor";
  store.db.prepare("INSERT INTO accounts(id,active,revision,auth_epoch,origin,created_at) VALUES(?,1,0,0,'test',?)")
    .run(A, Date.now());
  return { store, A };
}

function sponsorAgent(store, A) {
  const identity = store.identities.create("Sponsored agent");
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.identities.link(ownerKey, "commons", { identityId: identity.identityId, permissions: ["accept_work"] });
  // A sponsored agent connection, as produced by the agent-connections
  // "create" action: room credential plus sponsorship row.
  const credentialHash = sha256hex(randomBytes(32));
  const now = store.now();
  store.db.prepare(`INSERT INTO credentials(hash,room_id,member_id,kind,parent_hash,expires_at,revoked,account_id,account_auth_epoch)
    VALUES(?,'commons',?,'access',NULL,?,0,NULL,NULL)`)
    .run(credentialHash, identity.identityId, now + 86400000);
  const revision = store.roomAuthority("commons").members[identity.identityId].revision;
  store.db.prepare(`INSERT INTO agent_connections(room_id,member_id,generation,status,credential_hash,expires_at,
    sponsor_account_id,sponsor_member_id,sponsor_auth_epoch,sponsor_member_revision,member_revision,created_at,updated_at)
    VALUES('commons',?,1,'issued',?,? ,?,?,0,0,?,?,?)`)
    .run(identity.identityId, credentialHash, now + 86400000, A, "owner", revision, now, now);
  return identity;
}

test("account deletion fully disconnects sponsored agents: identity-secret auth dies too", t => {
  const { store, A } = setup(t);
  const agent = sponsorAgent(store, A);
  // Sanity: the sponsored agent authenticates with its identity secret now.
  const before = store.authenticate(agent.secret, "commons");
  assert.equal(before.member.id, agent.identityId);
  // The sponsor deletes their account.
  const { plan } = planAccountDeletion(store, A);
  const result = executeAccountDeletion(store, plan);
  const sponsored = result.purged.find(step => step.category === "sponsored_agents");
  assert.ok(sponsored, "plan purges the sponsored_agents category");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM credentials WHERE hash IN (SELECT credential_hash FROM agent_connections WHERE sponsor_account_id=?) AND revoked=0").get(A).n, 0, "room credentials revoked");
  // The sponsored agent's identity secret must no longer authenticate.
  assert.throws(() => store.authenticate(agent.secret, "commons"),
    error => [401, 403].includes(error.status),
    "sponsored agent identity-secret auth must fail after sponsor account deletion");
  assert.equal(store.identities.resolveIdentityAuth(agent.secret, "commons"), null,
    "identity link must no longer resolve in the room");
});
