// Terms acceptance, public abuse reports, and operator unpublish.
// No import from store.mjs: room-directory and the store both call this module.
import { createHash, randomBytes } from "node:crypto";

export const TERMS_VERSION = "2026-10-02";
export const SIGNUP_ORIGINS = new Set(["password-signup", "google-oauth", "google", "github-oauth", "magic-link"]);
export const REPORT_PROOF_BITS = 12;
const REPORT_BUCKET_MS = 10 * 60 * 1000;
const REPORT_KINDS = new Set(["room", "receipt", "agent"]);
const UNPUBLISH_KINDS = new Set(["room", "receipt"]);

export const accountTermsSchema = `CREATE TABLE IF NOT EXISTS account_terms (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  terms_version TEXT NOT NULL,
  accepted_at INTEGER NOT NULL
)`;

export const publicAbuseSchema = `CREATE TABLE IF NOT EXISTS public_abuse_reports (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  body TEXT NOT NULL,
  email TEXT,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
)`;

export const publicUnpublishSchema = `CREATE TABLE IF NOT EXISTS public_unpublish (
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  at INTEGER NOT NULL,
  by_account TEXT NOT NULL,
  PRIMARY KEY (kind, target)
)`;

export function recordSignupTerms(db, accountId, origin, now) {
  if (!SIGNUP_ORIGINS.has(origin)) return;
  db.prepare(`INSERT INTO account_terms (account_id, terms_version, accepted_at) VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO NOTHING`).run(accountId, TERMS_VERSION, now);
}

export function termsStatus(db, accountId) {
  let row = null;
  let origin = null;
  try {
    row = db.prepare("SELECT terms_version, accepted_at FROM account_terms WHERE account_id=?").get(accountId) ?? null;
    origin = db.prepare("SELECT origin FROM accounts WHERE id=?").get(accountId)?.origin ?? null;
  } catch {
    row = null;
  }
  const acceptedVersion = row?.terms_version ?? null;
  const acceptedAt = row ? row.accepted_at : null;
  const required = acceptedVersion !== TERMS_VERSION && (SIGNUP_ORIGINS.has(origin) || row != null);
  return { version: TERMS_VERSION, acceptedVersion, acceptedAt, required };
}

export function acceptCurrentTerms(db, accountId, version, now) {
  if (version !== TERMS_VERSION) {
    return { ok: false, status: 409, code: "terms_changed", message: "The terms changed. Read the current terms and accept them." };
  }
  db.prepare(`INSERT INTO account_terms (account_id, terms_version, accepted_at) VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET terms_version=excluded.terms_version, accepted_at=excluded.accepted_at`)
    .run(accountId, TERMS_VERSION, now);
  return { ok: true };
}

export function hashReportAddress(address) {
  return createHash("sha256").update(`project-room-public-report:${address}`).digest("hex");
}

export function reportChallenge(now = Date.now()) {
  return { bucket: Math.floor(now / REPORT_BUCKET_MS), bits: REPORT_PROOF_BITS, algorithm: "sha256-prefix" };
}

export function reportProofInput(bucket, kind, target, nonce) {
  return `${bucket}:${kind}:${target}:${nonce}`;
}

export function verifyReportProof({ bucket, kind, target, nonce }, now = Date.now()) {
  const current = Math.floor(now / REPORT_BUCKET_MS);
  if (!Number.isInteger(bucket) || bucket < current - 1 || bucket > current + 1) return false;
  if (!REPORT_KINDS.has(kind)) return false;
  if (typeof target !== "string" || !target || target.length > 128) return false;
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(nonce)) return false;
  const digest = createHash("sha256").update(reportProofInput(bucket, kind, target, nonce)).digest("hex");
  return digest.startsWith("0".repeat(REPORT_PROOF_BITS / 4));
}

const emailOk = value => typeof value === "string" && value.length <= 254 && value.length > 3
  && !value.includes("<") && !value.includes(">") && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export function submitPublicReport(db, { kind, target, body, email, ipHash, now }) {
  if (!REPORT_KINDS.has(kind)) return { ok: false, status: 422, code: "invalid_report", message: "kind must be room, receipt, or agent" };
  if (typeof target !== "string" || !target.trim() || target.length > 128) {
    return { ok: false, status: 422, code: "invalid_report", message: "A target id is required" };
  }
  if (typeof body !== "string" || body.trim().length < 1 || body.length > 1000) {
    return { ok: false, status: 422, code: "invalid_report", message: "The report must be 1 to 1,000 characters" };
  }
  if (email != null && !emailOk(email)) return { ok: false, status: 422, code: "invalid_report", message: "Email must be a plain address" };
  const id = `rpt_${randomBytes(16).toString("hex")}`;
  db.prepare(`INSERT INTO public_abuse_reports (id, kind, target, body, email, ip_hash, created_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`).run(id, kind, target, body, email ?? null, ipHash, now);
  return { ok: true, id };
}

export function countOpenPublicReports(store) {
  const db = store?.db;
  if (!db || typeof db.prepare !== "function") return 0;
  try {
    return Number(db.prepare("SELECT count(*) AS n FROM public_abuse_reports WHERE status='open'").get()?.n ?? 0);
  } catch {
    return 0;
  }
}

export function unpublishPublic(db, { kind, id, byAccount, now }) {
  if (!UNPUBLISH_KINDS.has(kind)) return { ok: false, status: 422, code: "invalid_unpublish", message: "kind must be room or receipt" };
  if (typeof id !== "string" || !id || id.length > 128) return { ok: false, status: 422, code: "invalid_unpublish", message: "An id is required" };
  db.prepare(`INSERT INTO public_unpublish (kind, target, at, by_account) VALUES (?, ?, ?, ?)
    ON CONFLICT(kind, target) DO UPDATE SET at=excluded.at, by_account=excluded.by_account`)
    .run(kind, id, now, byAccount);
  return { ok: true, kind, id };
}

export function isUnpublished(db, kind, target) {
  if (!db || typeof target !== "string" || !target) return false;
  try {
    return Boolean(db.prepare("SELECT 1 FROM public_unpublish WHERE kind=? AND target=?").get(kind, target));
  } catch {
    return false;
  }
}
