// Slice 5 (RC-2026-09-17-014) unit tests: the challenge store and the
// registration/authentication wiring in server/account-passkeys.mjs.
//
// The crypto verifiers are stubbed (injected), never forked: real WebAuthn
// assertion/registration crypto stays covered by src/passkey-login.mjs's own
// tests. These tests cover single-use/TTL/eviction, the begin/finish
// wiring, replay rejection, and the model calls (persist + touch).
import test from "node:test";
import assert from "node:assert/strict";
import { createChallengeStore, createPasskeyAuth, resolvePasskeyParams, PASSKEY_CHALLENGE_TTL_MS } from "../server/account-passkeys.mjs";

const isNonEmptyString = value => typeof value === "string" && value.length > 0;
const unauthorized = fn => assert.throws(fn, error => error?.status === 401);

// Deterministic clock + randomness for the challenge store.
function fixtures({ ttlMs = PASSKEY_CHALLENGE_TTL_MS } = {}) {
  let at = 1_000_000;
  let counter = 0;
  // Deterministic and unique per call: the counter is encoded in the head.
  const random = size => {
    counter += 1;
    const buf = Buffer.alloc(size);
    buf.writeUInt32BE(counter >>> 0, 0);
    for (let i = 4; i < size; i += 1) buf[i] = (counter * 31 + i * 37) % 256;
    return buf;
  };
  const challenges = createChallengeStore({ now: () => at, ttlMs, random });
  return { challenges, setNow: value => { at = value; }, random };
}

function fakeModel() {
  const credentials = new Map(); // credentialId -> { accountId }
  return {
    listed: [],
    registered: [],
    touched: [],
    signCounts: new Map(),
    listPasskeyCredentials(accountId) { this.listed.push(accountId); return []; },
    registerPasskeyCredential(accountId, record, { label } = {}) {
      this.registered.push({ accountId, record, label });
      credentials.set(record.id, { accountId });
      return { id: "lm_test", credentialId: record.id };
    },
    passkeyStore() {
      const self = this;
      return {
        getCredential: id => credentials.get(id),
        updateSignCount: (id, count) => { self.signCounts.set(id, count); }
      };
    },
    touchMethod(accountId, methodId) { this.touched.push({ accountId, methodId }); return { touched: true }; }
  };
}

function fakeStore(model) {
  return {
    accountLogins: model,
    now: () => 1_000_000,
    db: { prepare: () => ({ get: () => ({ methodId: "lm_test" }) }) }
  };
}

const stubVerifiers = {
  createRegistrationOptions: ({ rpId, user, challenge, excludeCredentials }) => ({
    options: { challenge, rp: { id: rpId, name: rpId }, user, excludeCredentials },
    challenge
  }),
  verifyRegistrationResponse: ({ response }) => {
    if (response?.bad) throw new Error("bad attestation");
    return { id: "cred-1", rpId: "example.test", publicKeyCose: "cose", publicKeyJwk: { kty: "EC" }, signCount: 0 };
  },
  createAuthenticationOptions: ({ rpId, challenge, allowCredentials }) => ({
    options: { challenge, rpId, allowCredentials },
    challenge
  }),
  verifyAuthenticationAssertion: ({ assertion, store }) => {
    if (assertion?.bad) throw new Error("bad signature");
    const record = store.getCredential("cred-1");
    store.updateSignCount("cred-1", 7);
    return { credentialId: "cred-1", userHandle: null, signCount: 7, accountId: record.accountId };
  }
};

function service(overrides = {}) {
  const { challenges } = fixtures();
  const model = fakeModel();
  const auth = createPasskeyAuth({ store: fakeStore(model), challenges, verifiers: stubVerifiers, ...overrides });
  return { auth, challenges, model };
}

test("resolvePasskeyParams enforces the https-or-localhost origin rule", () => {
  const savedRpId = process.env.ROOM_PASSKEY_RP_ID;
  delete process.env.ROOM_PASSKEY_RP_ID;
  try {
    assert.deepEqual(resolvePasskeyParams("https://room.example.test"), { origin: "https://room.example.test", rpId: "room.example.test" });
    assert.deepEqual(resolvePasskeyParams("https://room.example.test:8443/x", "custom-rp.test"),
      { origin: "https://room.example.test:8443", rpId: "custom-rp.test" });
    for (const loopback of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      const params = resolvePasskeyParams(loopback);
      assert.ok(params.origin.startsWith("http://"), loopback);
      assert.ok(isNonEmptyString(params.rpId), loopback);
    }
    assert.throws(() => resolvePasskeyParams("http://example.com"), { status: 422, code: "passkey_origin_rejected" });
    assert.throws(() => resolvePasskeyParams("http://192.168.1.10:3000"), { status: 422 });
    assert.equal(resolvePasskeyParams("not a url"), null);
    assert.equal(resolvePasskeyParams(""), null);
  } finally {
    if (savedRpId === undefined) delete process.env.ROOM_PASSKEY_RP_ID;
    else process.env.ROOM_PASSKEY_RP_ID = savedRpId;
  }
});

test("challenge store issues consumable single-use challenges", () => {
  const { challenges } = fixtures();
  const issued = challenges.issueChallenge("register", "acct-1");
  assert.match(issued.id, /^[A-Za-z0-9_-]+$/);
  assert.match(issued.challenge, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(issued.id, issued.challenge);
  const record = challenges.consumeChallenge(issued.id);
  assert.equal(record.purpose, "register");
  assert.equal(record.accountId, "acct-1");
  assert.equal(record.challenge, issued.challenge);
  unauthorized(() => challenges.consumeChallenge(issued.id)); // replay rejected
});

test("challenge store rejects unknown ids and expired challenges with 401", () => {
  const { challenges, setNow } = fixtures({ ttlMs: 1000 });
  unauthorized(() => challenges.consumeChallenge("nope"));
  unauthorized(() => challenges.consumeChallenge(null));
  const issued = challenges.issueChallenge("authenticate", null);
  setNow(1_000_000 + 1001);
  unauthorized(() => challenges.consumeChallenge(issued.id));
});

test("challenge store evicts the oldest entries past ~1000", () => {
  const { challenges } = fixtures();
  const first = challenges.issueChallenge("register", "acct-0");
  for (let i = 1; i < 1005; i += 1) challenges.issueChallenge("register", `acct-${i}`);
  assert.ok(challenges.size <= 1000, `bounded, got ${challenges.size}`);
  unauthorized(() => challenges.consumeChallenge(first.id)); // oldest evicted
});

test("beginRegistration builds options, persists the challenge, excludes existing credentials", () => {
  const { auth, challenges, model } = service();
  const options = auth.beginRegistration({ accountId: "acct-1", rpId: "example.test", userName: "Ada" });
  assert.equal(options.rp.id, "example.test");
  assert.equal(options.user.name, "Ada");
  assert.deepEqual(options.excludeCredentials, []);
  assert.ok(isNonEmptyString(options.challengeId));
  assert.deepEqual(model.listed, ["acct-1"]);
  // The issued challenge is live in the store and consumable once.
  const record = challenges.consumeChallenge(options.challengeId);
  assert.equal(record.challenge, options.challenge);
});

test("beginRegistration rejects bad input", () => {
  const { auth } = service();
  assert.throws(() => auth.beginRegistration({ accountId: "", rpId: "example.test", userName: "Ada" }), { status: 422 });
  assert.throws(() => auth.beginRegistration({ accountId: "a", rpId: "", userName: "Ada" }), { status: 422 });
  assert.throws(() => auth.beginRegistration({ accountId: "a", rpId: "example.test", userName: "" }), { status: 422 });
  assert.throws(() => auth.beginRegistration({ accountId: "a", rpId: "example.test", userName: "Ada", authenticatorSelection: "x" }), { status: 422 });
  assert.throws(() => createPasskeyAuth({}), TypeError);
});

test("finishRegistration verifies, persists the credential, and returns the credential id", () => {
  const { auth, model } = service();
  const options = auth.beginRegistration({ accountId: "acct-1", rpId: "example.test", userName: "Ada" });
  const result = auth.finishRegistration({ accountId: "acct-1", challengeId: options.challengeId,
    response: { id: "cred-1" }, expectedOrigin: "https://example.test", rpId: "example.test" });
  assert.deepEqual(result, { ok: true, credentialId: "cred-1" });
  assert.equal(model.registered.length, 1);
  assert.equal(model.registered[0].accountId, "acct-1");
  assert.equal(model.registered[0].label, "Passkey");
  assert.equal(model.registered[0].record.id, "cred-1");
});

test("finishRegistration rejects replayed challenges and cross-account binding", () => {
  const { auth } = service();
  const options = auth.beginRegistration({ accountId: "acct-1", rpId: "example.test", userName: "Ada" });
  const finish = { accountId: "acct-1", challengeId: options.challengeId, response: { id: "cred-1" },
    expectedOrigin: "https://example.test", rpId: "example.test" };
  assert.deepEqual(auth.finishRegistration(finish).ok, true);
  unauthorized(() => auth.finishRegistration(finish)); // replayed challenge
  const other = auth.beginRegistration({ accountId: "acct-1", rpId: "example.test", userName: "Ada" });
  unauthorized(() => auth.finishRegistration({ ...finish, accountId: "acct-2", challengeId: other.challengeId }));
  const authPurpose = auth.beginAuthentication({ rpId: "example.test" });
  unauthorized(() => auth.finishRegistration({ ...finish, challengeId: authPurpose.challengeId })); // wrong purpose
});

test("finishRegistration maps verifier failures to 401, not 500", () => {
  const { auth } = service();
  const options = auth.beginRegistration({ accountId: "acct-1", rpId: "example.test", userName: "Ada" });
  unauthorized(() => auth.finishRegistration({ accountId: "acct-1", challengeId: options.challengeId,
    response: { bad: true }, expectedOrigin: "https://example.test", rpId: "example.test" }));
});

test("beginAuthentication issues a discoverable-credential challenge", () => {
  const { auth, challenges } = service();
  const options = auth.beginAuthentication({ rpId: "example.test" });
  assert.equal(options.rpId, "example.test");
  assert.deepEqual(options.allowCredentials, []);
  assert.ok(isNonEmptyString(options.challengeId));
  const record = challenges.consumeChallenge(options.challengeId);
  assert.equal(record.purpose, "authenticate");
  assert.equal(record.accountId, null);
  assert.throws(() => auth.beginAuthentication({ rpId: "" }), { status: 422 });
});

test("finishAuthentication verifies the assertion, touches the method, and returns the account", () => {
  const { auth, model } = service();
  model.registerPasskeyCredential("acct-9", { id: "cred-1", rpId: "example.test", publicKeyCose: "cose",
    publicKeyJwk: { kty: "EC" }, signCount: 0 });
  const options = auth.beginAuthentication({ rpId: "example.test" });
  const result = auth.finishAuthentication({ challengeId: options.challengeId,
    response: { id: "cred-1" }, expectedOrigin: "https://example.test", rpId: "example.test" });
  assert.deepEqual(result, { ok: true, accountId: "acct-9", methodRef: "lm_test" });
  assert.deepEqual(model.touched, [{ accountId: "acct-9", methodId: "lm_test" }]);
  assert.equal(model.signCounts.get("cred-1"), 7);
});

test("finishAuthentication rejects replayed challenges and failed assertions with 401", () => {
  const { auth, model } = service();
  model.registerPasskeyCredential("acct-9", { id: "cred-1", rpId: "example.test", publicKeyCose: "cose",
    publicKeyJwk: { kty: "EC" }, signCount: 0 });
  const options = auth.beginAuthentication({ rpId: "example.test" });
  const finish = { challengeId: options.challengeId, response: { id: "cred-1" },
    expectedOrigin: "https://example.test", rpId: "example.test" };
  assert.equal(auth.finishAuthentication(finish).ok, true);
  unauthorized(() => auth.finishAuthentication(finish)); // replayed challenge
  const retry = auth.beginAuthentication({ rpId: "example.test" });
  unauthorized(() => auth.finishAuthentication({ ...finish, challengeId: retry.challengeId, response: { bad: true } }));
});
