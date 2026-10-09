// Seed a synthetic account session into the local fuzz DB so the authenticated
// /api/auth/email/verify/resend path can be exercised. All data is synthetic.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";

const DB = process.argv[2] || ".tmp/w5-room.sqlite";
const sha256 = t => createHash("sha256").update(t).digest("hex");
const key43 = () => randomBytes(32).toString("base64url"); // 43 chars

const now = Date.now();
const slotToken = key43();
const parentToken = key43();
const accountId = "w5-fuzz-account-01";
const revision = 0;
const csrf = sha256(`account-csrf:${slotToken}:${revision}`);
const email = "fuzz-test@example.com";
const emailHash = sha256(email.trim().toLowerCase());

// Extra seeded accounts for resend branch coverage:
// A2: verified email -> 200 already_verified
// A3: no login_methods email -> 422 invalid_email (no email to verify)
// A4: malformed stored email -> 422 invalid_email (normalizeEmail null)
const extras = [
  { id: "w5-fuzz-account-02", email: "verified@example.com", verifiedAt: now, emailHash: sha256("verified@example.com") },
  { id: "w5-fuzz-account-03", email: null, verifiedAt: null, emailHash: null },
  { id: "w5-fuzz-account-04", email: "not-an-email", verifiedAt: null, emailHash: sha256("not-an-email") },
];

let db, lastErr, seeded = false;
for (let i = 0; i < 10; i++) {
  try {
    db = new DatabaseSync(DB);
    // Writer fence: triggers call project_room_writer_v38() which must return
    // the schema version (38). Register it like the server does.
    db.function("project_room_writer_v38", () => 38);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`INSERT OR REPLACE INTO accounts (id, active, revision, auth_epoch, origin, created_at, display_name, onboarded)
        VALUES (?,?,?,?,?,?,?,1)`).run(accountId, 1, 1, 1, "http://127.0.0.1:4195", now, "w5 fuzz");
      db.prepare(`INSERT OR REPLACE INTO account_credentials (hash, account_id, account_auth_epoch, expires_at, revoked, created_at)
        VALUES (?,?,?,?,0,?)`).run(sha256(parentToken), accountId, 1, now + 3600_000, now);
      db.prepare(`INSERT OR REPLACE INTO account_session_slots (hash, revision, account_id, account_auth_epoch, parent_credential_hash, expires_at, authenticated_until, created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(sha256(slotToken), revision, accountId, 1, sha256(parentToken), now + 3600_000, now + 3600_000, now);
      db.prepare(`INSERT OR REPLACE INTO account_login_methods (id, account_id, type, label, email, email_hash, disabled, verified_at, created_at)
        VALUES (?,?,?,?,?,?,0,NULL,?)`).run("w5-lm-01", accountId, "password", "fuzz", email, emailHash, now);
      const out = { main: { slotToken, csrf, accountId, email } };
      let n = 1;
      for (const ex of extras) {
        n++;
        const st = key43(), pt = key43();
        db.prepare(`INSERT OR REPLACE INTO accounts (id, active, revision, auth_epoch, origin, created_at, display_name, onboarded)
          VALUES (?,?,?,?,?,?,?,1)`).run(ex.id, 1, 1, 1, "http://127.0.0.1:4195", now, "w5 fuzz extra");
        db.prepare(`INSERT OR REPLACE INTO account_credentials (hash, account_id, account_auth_epoch, expires_at, revoked, created_at)
          VALUES (?,?,?,?,0,?)`).run(sha256(pt), ex.id, 1, now + 3600_000, now);
        db.prepare(`INSERT OR REPLACE INTO account_session_slots (hash, revision, account_id, account_auth_epoch, parent_credential_hash, expires_at, authenticated_until, created_at)
          VALUES (?,?,?,?,?,?,?,?)`).run(sha256(st), 0, ex.id, 1, sha256(pt), now + 3600_000, now + 3600_000, now);
        if (ex.email !== null) {
          db.prepare(`INSERT OR REPLACE INTO account_login_methods (id, account_id, type, label, email, email_hash, disabled, verified_at, created_at)
            VALUES (?,?,?,?,?,?,0,?,?)`).run(`w5-lm-0${n}`, ex.id, "password", "fuzz", ex.email, ex.emailHash, ex.verifiedAt, now);
        }
        out[`extra${n - 1}`] = { slotToken: st, csrf: sha256(`account-csrf:${st}:0`), accountId: ex.id, email: ex.email };
      }
      db.exec("COMMIT");
      seeded = true;
      console.log(JSON.stringify(out, null, 2));
      break;
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 200)); }
}
if (!seeded) { console.error("seed failed:", lastErr?.message); process.exit(1); }
db.close();
