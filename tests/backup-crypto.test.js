// H003: backup encryption. Pure crypto tests; no store.
import test from "node:test";
import assert from "node:assert/strict";
import { deriveKey, encryptBackup, decryptBackup, rotateKey, BackupCryptoError } from "../server/backup-crypto.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof BackupCryptoError && error.code === code);
const key = () => deriveKey("correct horse battery staple", "salty-salt-1");

test("encrypt/decrypt round-trips", () => {
  const envelope = encryptBackup("backup payload", key());
  assert.equal(envelope.algorithm, "aes-256-gcm");
  assert.ok(Object.isFrozen(envelope));
  const plaintext = decryptBackup(envelope, key());
  assert.equal(plaintext.toString("utf8"), "backup payload");
  // Two encryptions differ (random IV).
  const again = encryptBackup("backup payload", key());
  assert.notEqual(again.ciphertext, envelope.ciphertext);
});
test("tampered ciphertext and wrong keys are refused", () => {
  const envelope = encryptBackup("secret", key());
  const tampered = { ...envelope, ciphertext: Buffer.from("evil").toString("base64") };
  throwsCode(() => decryptBackup(tampered, key()), "decrypt_failed");
  throwsCode(() => decryptBackup(envelope, deriveKey("wrong passphrase 123", "salty-salt-1")), "decrypt_failed");
});
test("rotateKey re-encrypts under the new key", () => {
  const envelope = encryptBackup("rotate me", key());
  const newKey = deriveKey("a brand new passphrase 99", "other-salt-22");
  const rotated = rotateKey(envelope, key(), newKey);
  assert.equal(decryptBackup(rotated, newKey).toString("utf8"), "rotate me");
  throwsCode(() => decryptBackup(rotated, key()), "decrypt_failed");
});
test("malformed inputs are refused", () => {
  throwsCode(() => deriveKey("short", "salty-salt-1"), "invalid_backup_crypto");
  throwsCode(() => encryptBackup("x", Buffer.alloc(16)), "invalid_backup_crypto");
  throwsCode(() => decryptBackup({ algorithm: "rot13" }, key()), "invalid_backup_crypto");
});
