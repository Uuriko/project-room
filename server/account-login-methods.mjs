// Slice 1 (RC-2026-09-17-010) — credential-type model for multi-method login.
//
// One account, many login credentials. Each login method links to an
// account and can be listed, disabled, or removed independently; the
// account keeps working as long as at least one active method remains.
//
// Method types:
//   password          — email + scrypt verifier (crypto lives in src/password-auth.mjs, slice 2)
//   magic             — verified email address that may receive magic-link codes
//   oauth             — provider ('github' | 'google') + provider subject + verified email
//   passkey           — one method row per WebAuthn credential; key material in account_passkey_credentials
//   recovery-code-set — one active set per account; codes in account_recovery_codes
//
// Security rules (per docs/SECRETS-ROTATION.md and docs/TOTP-2FA.md):
// - No secret value is ever logged or returned by list methods.
// - Magic-link codes and recovery codes are hashed at rest (sha256 with a
//   per-row salt for recovery codes); codes are single-use and burned.
// - Comparisons of secrets use constant-time equality; scrypt verification
//   (slice 2) is inherently data-dependent-safe.
// - OAuth linking is keyed on the verified provider subject, never on the
//   email address; the email is stored only so the settings UI can display
//   which address the provider attested to.
//
// This module is storage + linking logic only: no network, no timers, no
// mail. Randomness and time are injectable so tests drive it
// deterministically. HTTP routes and method-specific crypto are
// follow-up slices; they all build on this model.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ServiceError } from "./store.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const accountLoginMethodsSchema = `
  CREATE TABLE IF NOT EXISTS account_login_methods (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    type TEXT NOT NULL CHECK(type IN ('password','magic','oauth','passkey','recovery-code-set')),
    provider TEXT,
    label TEXT NOT NULL,
    email TEXT,
    email_hash TEXT,
    verifier TEXT,
    external_subject TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1))
  );
  CREATE INDEX IF NOT EXISTS account_login_method_account ON account_login_methods(account_id);
  CREATE INDEX IF NOT EXISTS account_login_method_email ON account_login_methods(email_hash);
  CREATE INDEX IF NOT EXISTS account_login_method_oauth ON account_login_methods(provider, external_subject);
  CREATE TABLE IF NOT EXISTS account_passkey_credentials (
    credential_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    method_id TEXT NOT NULL REFERENCES account_login_methods(id),
    rp_id TEXT NOT NULL,
    public_key_cose TEXT NOT NULL,
    public_key_jwk TEXT NOT NULL,
    sign_count INTEGER NOT NULL DEFAULT 0,
    aaguid TEXT,
    fmt TEXT,
    transports TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1))
  );
  CREATE INDEX IF NOT EXISTS account_passkey_credential_account ON account_passkey_credentials(account_id);
  CREATE TABLE IF NOT EXISTS account_magic_codes (
    code_hash TEXT PRIMARY KEY,
    account_id TEXT REFERENCES accounts(id),
    email TEXT NOT NULL,
    email_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS account_magic_code_email ON account_magic_codes(email_hash);
  CREATE TABLE IF NOT EXISTS account_recovery_codes (
    code_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    used_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS account_recovery_code_account ON account_recovery_codes(account_id);
`;

export const LOGIN_METHOD_TYPES = Object.freeze(["password", "magic", "oauth", "passkey", "recovery-code-set"]);
export const OAUTH_PROVIDERS = Object.freeze(["github", "google"]);
export const MAGIC_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const MAGIC_CODE_MAX_ATTEMPTS = 5;

const sha256hex = text => createHash("sha256").update(text, "utf8").digest("hex");
const base64url = bytes => Buffer.from(bytes).toString("base64url");

// Normalize an email for identity matching: lowercase, trimmed. Lookup
// keys are sha256 of the normalized form so indexes never depend on case.
export function normalizeEmail(email) {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  // Bounded, plain-ASCII sanity check — full RFC validation is the
  // mail layer's job; the model only needs a stable lookup key.
  if (normalized.length === 0 || normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

export const emailLookupHash = email => sha256hex(email);

// Constant-time comparison for fixed-format hex digests. Returns false
// (never throws) on shape mismatches.
export function constantTimeDigestEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

const isNonEmptyString = value => typeof value === "string" && value.length > 0;

// Public descriptor: safe for the settings UI — never carries verifiers,
// code hashes, or secrets of any kind.
function methodDescriptor(row) {
  return {
    id: row.id,
    type: row.type,
    provider: row.provider ?? null,
    label: row.label,
    email: row.email ?? null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
    disabled: row.disabled === 1
  };
}

export class AccountLoginMethods {
  constructor(store, { random = randomBytes, now = null } = {}) {
    this.store = store;
    this.db = store.db;
    this.random = random;
    this.now = now ?? (() => store.now());
  }

  #now() { return this.now(); }

  #getAccount(accountId) {
    const row = this.db.prepare("SELECT id, active FROM accounts WHERE id=?").get(accountId);
    if (!row) fail(404, "account_not_found", "Account not found");
    if (row.active !== 1) fail(403, "access_denied", "Active account required");
    return row;
  }

  // List login methods for the settings UI. Verifiers are never exposed.
  listMethods(accountId) {
    this.#getAccount(accountId);
    return this.db.prepare("SELECT * FROM account_login_methods WHERE account_id=? ORDER BY created_at")
      .all(accountId).map(methodDescriptor);
  }

  // Find the account that owns a verified email login method
  // (password or magic). Used for linking: a magic-link sign-in to an
  // email that already has a password attaches to the same account.
  findAccountByVerifiedEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const row = this.db.prepare(`SELECT account_id AS accountId FROM account_login_methods
      WHERE email_hash=? AND type IN ('password','magic') AND disabled=0
      ORDER BY created_at LIMIT 1`).get(emailLookupHash(normalized));
    return row ? row.accountId : null;
  }

  // Find the account bound to an OAuth provider subject (never by email).
  findAccountByOAuth(provider, subject) {
    if (!OAUTH_PROVIDERS.includes(provider) || !isNonEmptyString(subject)) return null;
    const row = this.db.prepare(`SELECT account_id AS accountId FROM account_login_methods
      WHERE type='oauth' AND provider=? AND external_subject=? AND disabled=0 LIMIT 1`)
      .get(provider, subject);
    return row ? row.accountId : null;
  }

  #insertMethod({ accountId, type, provider = null, label, email = null, verifier = null, externalSubject = null }) {
    const knownType = LOGIN_METHOD_TYPES.includes(type);
    if (!knownType) fail(422, "invalid_login_method", "Unknown login method type");
    if (provider !== null && !OAUTH_PROVIDERS.includes(provider)) fail(422, "invalid_login_method", "Unknown OAuth provider");
    if (!isNonEmptyString(label) || label.length > 80) fail(422, "invalid_login_method", "A method label of 1-80 characters is required");
    const normalizedEmail = email === null ? null : normalizeEmail(email);
    if (email !== null && normalizedEmail === null) fail(422, "invalid_email", "A valid email address is required");
    const id = `lm_${base64url(this.random(12))}`;
    const createdAt = this.#now();
    this.db.prepare(`INSERT INTO account_login_methods(id,account_id,type,provider,label,email,email_hash,verifier,external_subject,created_at,last_used_at,disabled)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,0)`)
      .run(id, accountId, type, provider, label.trim(), normalizedEmail,
        normalizedEmail ? emailLookupHash(normalizedEmail) : null,
        verifier, externalSubject, createdAt, null);
    return this.getMethod(accountId, id);
  }

  getMethod(accountId, methodId) {
    const row = this.db.prepare("SELECT * FROM account_login_methods WHERE id=? AND account_id=?").get(methodId, accountId);
    if (!row) fail(404, "login_method_not_found", "Login method not found");
    return methodDescriptor(row);
  }

  #rawMethod(accountId, methodId) {
    const row = this.db.prepare("SELECT * FROM account_login_methods WHERE id=? AND account_id=?").get(methodId, accountId);
    if (!row) fail(404, "login_method_not_found", "Login method not found");
    return row;
  }

  // Link an email+password method. The verifier is the opaque scrypt hash
  // produced by src/password-auth.mjs (slice 2) — this model never sees a
  // plaintext password.
  linkPasswordMethod(accountId, { email, verifier, label = "Password" }) {
    this.#getAccount(accountId);
    if (!isNonEmptyString(verifier) || verifier.length > 512) fail(422, "invalid_login_method", "A password verifier is required");
    return this.store.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM account_login_methods WHERE account_id=? AND type='password' AND disabled=0")
        .get(accountId);
      if (existing) fail(409, "login_method_exists", "This account already has a password; change it instead");
      return this.#insertMethod({ accountId, type: "password", label, email, verifier });
    });
  }

  // Replace the password verifier (change-password flow, slice 2).
  setPasswordVerifier(accountId, verifier) {
    this.#getAccount(accountId);
    if (!isNonEmptyString(verifier) || verifier.length > 512) fail(422, "invalid_login_method", "A password verifier is required");
    const changed = this.db.prepare("UPDATE account_login_methods SET verifier=? WHERE account_id=? AND type='password' AND disabled=0")
      .run(verifier, accountId).changes;
    if (changed !== 1) fail(404, "login_method_not_found", "No password is set on this account");
    return { updated: true };
  }

  // Raw verifier read for the password slice only. Never exposed over HTTP.
  readPasswordVerifier(accountId) {
    const row = this.db.prepare("SELECT verifier FROM account_login_methods WHERE account_id=? AND type='password' AND disabled=0 LIMIT 1")
      .get(accountId);
    return row ? row.verifier : null;
  }

  // Link a verified email as a magic-link method (the address itself is the
  // method; codes are ephemeral and live in account_magic_codes).
  linkMagicMethod(accountId, { email, label = "Email magic link" }) {
    this.#getAccount(accountId);
    const normalized = normalizeEmail(email);
    if (!normalized) fail(422, "invalid_email", "A valid email address is required");
    return this.store.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM account_login_methods WHERE account_id=? AND type='magic' AND email_hash=? AND disabled=0")
        .get(accountId, emailLookupHash(normalized));
      if (existing) fail(409, "login_method_exists", "This email is already linked for magic-link sign-in");
      return this.#insertMethod({ accountId, type: "magic", label, email: normalized });
    });
  }

  // Link an OAuth provider. Keyed on provider subject — a verified email
  // collision only links when it belongs to the same account (the caller
  // decides; this model reports the existing owner).
  linkOAuthMethod(accountId, { provider, subject, email = null, label = null }) {
    this.#getAccount(accountId);
    if (!OAUTH_PROVIDERS.includes(provider)) fail(422, "invalid_login_method", "Unknown OAuth provider");
    if (!isNonEmptyString(subject) || subject.length > 255) fail(422, "invalid_login_method", "A provider subject is required");
    return this.store.transaction(() => {
      const owner = this.findAccountByOAuth(provider, subject);
      if (owner && owner !== accountId) fail(409, "login_method_exists", "This provider account is already linked elsewhere");
      const existing = this.db.prepare("SELECT id FROM account_login_methods WHERE account_id=? AND type='oauth' AND provider=? AND external_subject=? AND disabled=0")
        .get(accountId, provider, subject);
      if (existing) fail(409, "login_method_exists", "This provider account is already linked");
      return this.#insertMethod({
        accountId, type: "oauth", provider, label: label ?? `Continue with ${provider[0].toUpperCase()}${provider.slice(1)}`,
        email, externalSubject: subject
      });
    });
  }

  // Record a successful login against a method (settings UI "last used").
  touchMethod(accountId, methodId) {
    const row = this.#rawMethod(accountId, methodId);
    this.db.prepare("UPDATE account_login_methods SET last_used_at=? WHERE id=?").run(this.#now(), row.id);
    return { touched: true };
  }

  touchMethodByOAuth(provider, subject) {
    if (!OAUTH_PROVIDERS.includes(provider) || !isNonEmptyString(subject)) return { touched: false };
    const changed = this.db.prepare("UPDATE account_login_methods SET last_used_at=? WHERE type='oauth' AND provider=? AND external_subject=? AND disabled=0")
      .run(this.#now(), provider, subject).changes;
    return { touched: changed === 1 };
  }

  // Disable/enable a method. Disabling the last active method is refused —
  // an account must always keep a way in.
  setMethodDisabled(accountId, methodId, disabled) {
    this.#getAccount(accountId);
    return this.store.transaction(() => {
      const row = this.#rawMethod(accountId, methodId);
      const want = disabled ? 1 : 0;
      if (row.disabled === want) return { ...methodDescriptor(row), disabled: want === 1 };
      if (want === 1) {
        const active = this.db.prepare("SELECT count(*) AS n FROM account_login_methods WHERE account_id=? AND disabled=0").get(accountId).n;
        if (active <= 1) fail(409, "last_login_method", "Keep at least one active sign-in method");
      }
      this.db.prepare("UPDATE account_login_methods SET disabled=? WHERE id=?").run(want, row.id);
      return { ...methodDescriptor(row), disabled: want === 1 };
    });
  }

  // Remove a method entirely. Same last-method guard as disabling.
  removeMethod(accountId, methodId) {
    this.#getAccount(accountId);
    return this.store.transaction(() => {
      const row = this.#rawMethod(accountId, methodId);
      const active = this.db.prepare("SELECT count(*) AS n FROM account_login_methods WHERE account_id=? AND disabled=0").get(accountId).n;
      if (row.disabled === 0 && active <= 1) fail(409, "last_login_method", "Keep at least one active sign-in method");
      if (row.type === "passkey") {
        this.db.prepare("DELETE FROM account_passkey_credentials WHERE method_id=?").run(row.id);
      }
      if (row.type === "recovery-code-set") {
        this.db.prepare("DELETE FROM account_recovery_codes WHERE account_id=?").run(accountId);
      }
      this.db.prepare("DELETE FROM account_login_methods WHERE id=?").run(row.id);
      return { removed: true, id: row.id, type: row.type };
    });
  }

  // --- Passkey credential store (F019 wiring, slice 5) ---
  //
  // The credential record comes from verifyRegistrationResponse in
  // src/passkey-login.mjs. The server persists it here; private key
  // material never leaves the authenticator.

  registerPasskeyCredential(accountId, record, { label = "Passkey" } = {}) {
    this.#getAccount(accountId);
    if (record == null || typeof record !== "object") fail(422, "invalid_passkey", "A verified credential record is required");
    const { id: credentialId, rpId, publicKeyCose, publicKeyJwk, signCount, aaguid, fmt, transports } = record;
    if (!isNonEmptyString(credentialId) || !isNonEmptyString(rpId) || !isNonEmptyString(publicKeyCose) || record.publicKeyJwk == null) {
      fail(422, "invalid_passkey", "Credential record is missing required fields");
    }
    return this.store.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM account_passkey_credentials WHERE credential_id=?").get(credentialId)) {
        fail(409, "login_method_exists", "This passkey is already registered");
      }
      const method = this.#insertMethod({ accountId, type: "passkey", label, verifier: credentialId });
      this.db.prepare(`INSERT INTO account_passkey_credentials(credential_id,account_id,method_id,rp_id,public_key_cose,public_key_jwk,
        sign_count,aaguid,fmt,transports,created_at,last_used_at,disabled)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)`)
        .run(credentialId, accountId, method.id, rpId, publicKeyCose, JSON.stringify(publicKeyJwk),
          Number.isSafeInteger(signCount) ? signCount : 0,
          typeof aaguid === "string" ? aaguid : null, typeof fmt === "string" ? fmt : null,
          JSON.stringify(Array.isArray(transports) ? transports : []), this.#now(), null);
      return { ...method, credentialId };
    });
  }

  // Store adapter for src/passkey-login.mjs verifyAuthenticationAssertion:
  // { getCredential, updateSignCount }.
  passkeyStore() {
    const db = this.db;
    const now = this.#now.bind(this);
    return {
      getCredential(credentialId) {
        const row = db.prepare("SELECT * FROM account_passkey_credentials WHERE credential_id=? AND disabled=0").get(credentialId);
        if (!row) return undefined;
        return {
          id: row.credential_id, rawId: row.credential_id, rpId: row.rp_id,
          publicKeyCose: row.public_key_cose, publicKeyJwk: JSON.parse(row.public_key_jwk),
          signCount: row.sign_count, aaguid: row.aaguid, fmt: row.fmt,
          transports: JSON.parse(row.transports), accountId: row.account_id
        };
      },
      updateSignCount(credentialId, signCount) {
        db.prepare("UPDATE account_passkey_credentials SET sign_count=?, last_used_at=? WHERE credential_id=?")
          .run(signCount, now(), credentialId);
      }
    };
  }

  listPasskeyCredentials(accountId) {
    this.#getAccount(accountId);
    return this.db.prepare(`SELECT credential_id AS credentialId, rp_id AS rpId, sign_count AS signCount,
      aaguid, fmt, transports, created_at AS createdAt, last_used_at AS lastUsedAt, disabled
      FROM account_passkey_credentials WHERE account_id=? ORDER BY created_at`)
      .all(accountId)
      .map(row => ({ ...row, transports: JSON.parse(row.transports), disabled: row.disabled === 1 }));
  }

  removePasskeyCredential(accountId, credentialId) {
    this.#getAccount(accountId);
    return this.store.transaction(() => {
      const row = this.db.prepare("SELECT method_id AS methodId, account_id AS owner FROM account_passkey_credentials WHERE credential_id=?")
        .get(credentialId);
      if (!row || row.owner !== accountId) fail(404, "login_method_not_found", "Passkey not found");
      this.db.prepare("DELETE FROM account_passkey_credentials WHERE credential_id=?").run(credentialId);
      const remaining = this.db.prepare("SELECT count(*) AS n FROM account_passkey_credentials WHERE method_id=?").get(row.methodId).n;
      if (remaining === 0) this.db.prepare("DELETE FROM account_login_methods WHERE id=?").run(row.methodId);
      return { removed: true, credentialId };
    });
  }

  // --- Magic-link codes (slice 3) ---
  //
  // Single-use, short-TTL, hashed at rest. The plaintext code is returned
  // once to the caller (the mail layer sends it); only the sha256 digest
  // is stored. `accountId` may be null for a first-time signup: the account
  // is created when the code is consumed.

  issueMagicCode({ accountId = null, email, ttlMs = MAGIC_CODE_TTL_MS } = {}) {
    const normalized = normalizeEmail(email);
    if (!normalized) fail(422, "invalid_email", "A valid email address is required");
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 3600000) fail(422, "invalid_expiry", "Magic-link codes expire within 24 hours");
    if (accountId !== null) this.#getAccount(accountId);
    return this.store.transaction(() => {
      const now = this.#now();
      this.db.prepare("DELETE FROM account_magic_codes WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(now);
      const code = base64url(this.random(24)); // 192 bits, URL-safe
      this.db.prepare(`INSERT INTO account_magic_codes(code_hash,account_id,email,email_hash,expires_at,consumed_at,attempts,created_at)
        VALUES(?,?,?,?,?,?,0,?)`)
        .run(sha256hex(code), accountId, normalized, emailLookupHash(normalized), now + ttlMs, null, now);
      return { code, email: normalized, expiresAt: now + ttlMs };
    });
  }

  // Verify a code (constant-time) and burn it. Returns { accountId, email }.
  // Throws 401 on unknown/expired/consumed codes and burns the window after
  // too many wrong attempts against the same email bucket. The miss counter
  // is committed in its own transaction before the 401 is raised — a
  // rolled-back counter would let an attacker try forever.
  consumeMagicCode({ email, code }) {
    const normalized = normalizeEmail(email);
    if (!normalized) fail(422, "invalid_email", "A valid email address is required");
    if (typeof code !== "string" || code.length === 0) fail(401, "invalid_magic_code", "That code is not valid");
    const now = this.#now();
    const rows = this.db.prepare(`SELECT * FROM account_magic_codes
      WHERE email_hash=? AND consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 20`)
      .all(emailLookupHash(normalized), now);
    const digest = sha256hex(code);
    const match = rows.find(row => constantTimeDigestEqual(row.code_hash, digest));
    if (!match) {
      // Count the miss against the newest live code for this email so
      // brute force burns the window instead of trying forever.
      const newest = rows[0];
      if (newest) {
        const attempts = newest.attempts + 1;
        if (attempts >= MAGIC_CODE_MAX_ATTEMPTS) {
          this.db.prepare("DELETE FROM account_magic_codes WHERE code_hash=?").run(newest.code_hash);
        } else {
          this.db.prepare("UPDATE account_magic_codes SET attempts=? WHERE code_hash=?").run(attempts, newest.code_hash);
        }
      }
      fail(401, "invalid_magic_code", "That code is not valid");
    }
    return this.store.transaction(() => {
      this.db.prepare("UPDATE account_magic_codes SET consumed_at=? WHERE code_hash=?").run(now, match.code_hash);
      this.db.prepare("DELETE FROM account_magic_codes WHERE email_hash=? AND code_hash != ?")
        .run(emailLookupHash(normalized), match.code_hash);
      return { accountId: match.account_id, email: match.email };
    });
  }

  // --- Recovery codes (slice 6) ---
  //
  // A set of single-use codes shown once at generation. Stored as
  // sha256(salt || code) with the salt kept on the method row; codes burn
  // on use. Never logged, never listed.

  generateRecoveryCodes(accountId, { count = 10 } = {}) {
    this.#getAccount(accountId);
    if (!Number.isSafeInteger(count) || count < 1 || count > 50) fail(422, "invalid_login_method", "Code count must be 1-50");
    return this.store.transaction(() => {
      const salt = base64url(this.random(16));
      const codes = [];
      const hashes = [];
      for (let i = 0; i < count; i += 1) {
        const code = `${base64url(this.random(6))}-${base64url(this.random(6))}`.toLowerCase();
        codes.push(code);
        hashes.push(sha256hex(`${salt}:${code}`));
      }
      const existing = this.db.prepare("SELECT id FROM account_login_methods WHERE account_id=? AND type='recovery-code-set' AND disabled=0")
        .get(accountId);
      let methodId;
      if (existing) {
        methodId = existing.id;
        this.db.prepare("UPDATE account_login_methods SET verifier=? WHERE id=?").run(salt, methodId);
      } else {
        methodId = this.#insertMethod({ accountId, type: "recovery-code-set", label: "Recovery codes", verifier: salt }).id;
      }
      this.db.prepare("DELETE FROM account_recovery_codes WHERE account_id=?").run(accountId);
      const insert = this.db.prepare("INSERT INTO account_recovery_codes(code_hash,account_id,used_at,created_at) VALUES(?,?,NULL,?)");
      const now = this.#now();
      for (const codeHash of hashes) insert.run(codeHash, accountId, now);
      // The plaintext codes are returned exactly once — the caller shows
      // them and never persists them.
      return { methodId, codes, count };
    });
  }

  recoveryCodesRemaining(accountId) {
    this.#getAccount(accountId);
    return this.db.prepare("SELECT count(*) AS n FROM account_recovery_codes WHERE account_id=? AND used_at IS NULL")
      .get(accountId).n;
  }

  // Verify one recovery code and burn it. Returns true on success; throws
  // 401 otherwise (no oracle for which code was wrong — there is only one
  // candidate set).
  consumeRecoveryCode(accountId, code) {
    this.#getAccount(accountId);
    if (typeof code !== "string" || code.length === 0) fail(401, "invalid_recovery_code", "That recovery code is not valid");
    return this.store.transaction(() => {
      const method = this.db.prepare("SELECT verifier FROM account_login_methods WHERE account_id=? AND type='recovery-code-set' AND disabled=0")
        .get(accountId);
      if (!method || !isNonEmptyString(method.verifier)) fail(404, "login_method_not_found", "No recovery codes are set on this account");
      const digest = sha256hex(`${method.verifier}:${code.trim().toLowerCase()}`);
      const row = this.db.prepare("SELECT code_hash AS codeHash, used_at AS usedAt FROM account_recovery_codes WHERE account_id=?")
        .all(accountId)
        .find(candidate => constantTimeDigestEqual(candidate.codeHash, digest));
      if (!row || row.usedAt !== null) fail(401, "invalid_recovery_code", "That recovery code is not valid");
      this.db.prepare("UPDATE account_recovery_codes SET used_at=? WHERE code_hash=?").run(this.#now(), row.codeHash);
      return { consumed: true, remaining: this.recoveryCodesRemaining(accountId) };
    });
  }
}
