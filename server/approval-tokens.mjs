// #5384: approval tokens are stored only as a hash and can be used once.
// The raw token is returned to the approver exactly once. The server keeps
// sha256(token); presenting it compares hashes in constant time and burns
// the record on use (see burn below).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX = "apv_";
const hashOf = token => createHash("sha256").update(token).digest();

export function issueApprovalToken() {
  const token = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, tokenHash: hashOf(token).toString("hex") };
}

// record: { tokenHash, exp, used }. Returns "ok", "invalid", "expired" or
// "used". On "ok" the record is marked used before the caller acts on it,
// unless { burn: false }: then the caller marks record.used = true once its
// action commits, so a rolled-back attempt stays retryable but a completed
// one can never run twice.
export function consumeApprovalToken(record, presented, now, { burn = true } = {}) {
  if (!record || typeof record.tokenHash !== "string" || typeof presented !== "string" || !presented.startsWith(PREFIX) || presented.length > 128) return "invalid";
  const expected = Buffer.from(record.tokenHash, "hex");
  const actual = hashOf(presented);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return "invalid";
  if (record.used) return "used";
  if (record.exp <= now) return "expired";
  if (burn) record.used = true;
  return "ok";
}
