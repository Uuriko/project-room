// Backup encryption (H003). A pure AES-256-GCM envelope for backup
// payloads: deriveKey() stretches a passphrase with scrypt, encryptBackup()
// seals a Buffer/String under a random IV with an authentication tag, and
// decryptBackup() verifies the tag before returning plaintext (tampered
// ciphertext throws). rotateKey() re-encrypts under a new key. Keys are
// caller-owned Buffers and never persisted here. Pure Node crypto,
// dependency-free; frozen metadata outputs. Backup scheduling/rotation
// wiring is a later slice.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
class BackupCryptoError extends Error { constructor(code, message) { super(message); this.name = "BackupCryptoError"; this.code = code; } }
const fail = (code, message) => { throw new BackupCryptoError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_backup_crypto", message); };

const ALGORITHM = "aes-256-gcm", KEY_BYTES = 32, IV_BYTES = 12;
// Derive a 32-byte key from a passphrase and salt.
export function deriveKey(passphrase, salt) {
  check(typeof passphrase === "string" && passphrase.length >= 12, "passphrase must be a string of at least 12 characters");
  check(typeof salt === "string" && salt.length >= 8, "salt must be a string of at least 8 characters");
  return scryptSync(passphrase, salt, KEY_BYTES);
}
// Encrypt a backup payload. Returns { iv, tag, ciphertext, algorithm }.
export function encryptBackup(payload, key) {
  check(Buffer.isBuffer(key) && key.length === KEY_BYTES, "key must be a 32-byte Buffer");
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  check(data.length > 0 && data.length <= 256 * 1024 * 1024, "payload must be 1 byte .. 256 MiB");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const envelope = Object.freeze({ algorithm: ALGORITHM, iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
  return envelope;
}
// Decrypt an envelope. Throws on tampering or wrong key.
export function decryptBackup(envelope, key) {
  check(Buffer.isBuffer(key) && key.length === KEY_BYTES, "key must be a 32-byte Buffer");
  check(envelope !== null && typeof envelope === "object", "envelope must be an object");
  check(envelope.algorithm === ALGORITHM, `unsupported algorithm "${envelope?.algorithm}"`);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
  } catch {
    fail("decrypt_failed", "decryption failed: wrong key or tampered ciphertext");
  }
}
// Re-encrypt an envelope under a new key (decrypts with old, encrypts new).
export function rotateKey(envelope, oldKey, newKey) {
  return encryptBackup(decryptBackup(envelope, oldKey), newKey);
}
export { BackupCryptoError };
