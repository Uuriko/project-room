import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {verifyRuntimeSource} from '../scripts/runtime-package.mjs';

// A server module imported at runtime but missing from the runtime package
// allowlist passes deploy and smoke, then fails release-runtime packaging
// (c1851ec3, aad739ff). This guard runs on every affected selection so the
// PR that adds the module catches it.
test('every runtime import is in the runtime package allowlist', () => {
  assert.ok(verifyRuntimeSource(fileURLToPath(new URL('..', import.meta.url))).files > 100);
});
