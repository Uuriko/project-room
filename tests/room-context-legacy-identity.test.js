import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

test("compact context accepts legacy identities without making a read write auth state", () => {
  const store = new RoomStore(":memory:");
  try {
    store.initialize(initialRoom("commons"));
    const owner = store.issueAccessKey("commons", "owner");
    const identity = store.identities.create("Context reader");
    store.identities.link(owner, "commons", { identityId: identity.identityId, permissions: [] });
    const legacy = createHash("sha256").update(identity.secret).digest("hex");
    store.db.prepare("UPDATE agent_identities SET secret_hash=? WHERE identity_id=?").run(legacy, identity.identityId);
    const changes = store.db.prepare("SELECT total_changes() AS n").get().n;
    const context = store.roomContext(identity.secret, "commons");
    assert.equal(context.viewerId, identity.identityId);
    assert.equal(store.roomContext(identity.secret, "commons", { sinceVersion: context.context_version }).not_modified, true);
    assert.equal(store.db.prepare("SELECT total_changes() AS n").get().n, changes);
    assert.equal(store.storageStatus().failures, 0);
    store.identities.authenticateIdentitySecret(identity.identityId, identity.secret);
    assert.equal(store.roomContext(identity.secret, "commons", { sinceVersion: context.context_version }).not_modified, true);
    store.identities.revoke(identity.identityId, identity.secret);
    assert.throws(() => store.roomContext(identity.secret, "commons"), error => error.status === 401);
  } finally { store.close(); }
});
