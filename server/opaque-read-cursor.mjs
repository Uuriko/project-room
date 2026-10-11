import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const keys = new WeakMap();
export function opaqueReadCursor(store) {
  // Continuations are hints, never authority. A store restart invalidates them
  // explicitly instead of silently mixing pre-recovery and post-recovery pages.
  if (!keys.has(store)) keys.set(store, randomBytes(32));
  return {
    encode(value) {
      // Authenticated encryption also hides array offsets: readable offsets
      // would reveal where filtered private messages occur in the room.
      const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", keys.get(store), nonce);
      const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url");
    },
    decode(token) {
      try {
        if (typeof token !== "string" || token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
        const bytes = Buffer.from(token, "base64url");
        if (bytes.length < 29 || bytes.toString("base64url") !== token) return null;
        const decipher = createDecipheriv("aes-256-gcm", keys.get(store), bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
      } catch { return null; }
    }
  };
}
