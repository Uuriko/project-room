// H-14 regression (audit 2026-09-30): the file manager must seed its id
// counter from a caller-owned pre-populated store.
// Contract: createFiles({ store }) with existing files must mint ids that
// cannot collide with (and silently overwrite) a stored file. Credible
// regression: pre-fix fileCounter starts at 0, so the next register() mints
// file-1 again and overwrites the existing file-1. Existing coverage: no
// test file existed for this module. No new production seams: public
// createFiles/register/get API only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFiles } from '../server/room-files.mjs';

test('H-14: register on a pre-populated store does not reuse an existing file id', () => {
  const store = new Map();
  store.set('file-1', {
    fileId: 'file-1', roomId: 'r', filename: 'a.txt',
    mimeType: 'text/plain', sizeBytes: 1, uploaderId: 'u', previewable: true,
  });
  const files = createFiles({ store });
  const f = files.register({
    roomId: 'r', filename: 'b.txt', mimeType: 'text/plain', sizeBytes: 2, uploaderId: 'u',
  });
  assert.equal(f.fileId, 'file-2', 'must not reuse the existing file-1');
  assert.equal(files.get('file-1').filename, 'a.txt', 'existing file must not be overwritten');
});

test('register mints sequential ids on a fresh store', () => {
  const files = createFiles();
  const a = files.register({
    roomId: 'r', filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, uploaderId: 'u',
  });
  const b = files.register({
    roomId: 'r', filename: 'b.txt', mimeType: 'text/plain', sizeBytes: 2, uploaderId: 'u',
  });
  assert.equal(a.fileId, 'file-1');
  assert.equal(b.fileId, 'file-2');
});
