import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { backupRoom, reconcileRestoredAuthority } from '../server/backup.mjs';

// Distinct lifecycle risk from key authentication: a faithful older backup
// must report a supported same-id secret rotation, without disclosing secrets.
for (const kind of ['rak_key', 'onboarding_token']) {
  for (const transition of ['unchanged', 'rotate', 'revoke']) {
    test(`restore ${kind}: ${transition} has an exact secret-safe report`, async t => {
      const directory = mkdtempSync(join(tmpdir(), 'restore-key-rotation-'));
      const stores = [];
      t.after(() => { for (const store of stores.reverse()) store.close(); rmSync(directory, { recursive: true, force: true }); });
      const filename = join(directory, 'reference.sqlite');
      const current = new RoomStore(filename);
      stores.push(current);
      current.initialize(initialRoom('commons'));
      const identity = current.identities.create('Synthetic rotation fixture');
      const issued = current.agentPlugin.issueApiKey({
        identityId: identity.identityId,
        scopes: kind === 'onboarding_token'
          ? current.agentPlugin.onboardingMcpScopes('commons')
          : ['rooms:read'],
      });
      const snapshot = await backupRoom(filename, directory);
      let replacement;
      if (transition === 'rotate') replacement = current.agentPlugin.rotateApiKey({ identityId: identity.identityId, keyId: issued.keyId });
      if (transition === 'revoke') current.agentPlugin.revokeApiKey({ identityId: identity.identityId, keyId: issued.keyId });
      const restored = new RoomStore(snapshot.filename, { readOnly: true });
      stores.push(restored);
      const report = reconcileRestoredAuthority(restored, current);
      const expected = transition === 'unchanged' ? [] : [{
        kind, id: issued.keyId,
        detail: `${kind === 'onboarding_token' ? 'onboarding token' : 'API key'} for ${identity.identityId} was ${transition === 'rotate' ? 'rotated' : 'revoked'} after the backup`,
      }];
      assert.deepEqual(report.stale, expected);
      assert.equal(report.checkedClasses[kind], 1);
      assert.equal(report.checkedClasses[kind === 'rak_key' ? 'onboarding_token' : 'rak_key'], 0);
      const serialized = JSON.stringify(report);
      for (const secret of [issued.secret, replacement?.secret].filter(Boolean)) {
        assert.equal(serialized.includes(secret), false);
        assert.equal(serialized.includes(createHash('sha256').update(secret).digest('hex')), false);
      }
    });
  }
}
