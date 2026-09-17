// F019 — tests for src/passkey-login.mjs.
//
// Deterministic: randomness and time are injected everywhere. Real ES256
// signatures come from node:crypto (generateKeyPairSync + sign with
// ieee-p1363), and a tiny CBOR encoder below builds attestation objects —
// so the happy paths exercise the real verification code, not stubs.

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, generateKeyPairSync, createHash, sign } from "node:crypto";
import {
  WEBAUTHN_CREATE_TYPE,
  WEBAUTHN_GET_TYPE,
  CHALLENGE_BYTES,
  base64urlEncode,
  base64urlDecode,
  generateChallenge,
  issueChallenge,
  isChallengeFresh,
  createRegistrationOptions,
  createAuthenticationOptions,
  parseClientDataJSON,
  verifyClientData,
  cborDecode,
  parseAuthData,
  coseKeyToJwk,
  defaultVerifySignature,
  verifyRegistrationResponse,
  verifyAuthenticationAssertion,
} from "../src/passkey-login.mjs";

const RP_ID = "room.example";
const ORIGIN = "https://room.example";
const NOW = 1_786_000_000_000;

// --- tiny CBOR encoder (tests only) ---------------------------------------

function cborEncode(value) {
  const parts = [];
  const head = (major, n) => {
    if (n < 24) parts.push(Buffer.from([(major << 5) | n]));
    else if (n < 256) parts.push(Buffer.from([(major << 5) | 24, n]));
    else if (n < 65536) {
      const b = Buffer.alloc(3);
      b[0] = (major << 5) | 25;
      b.writeUInt16BE(n, 1);
      parts.push(b);
    } else {
      const b = Buffer.alloc(5);
      b[0] = (major << 5) | 26;
      b.writeUInt32BE(n, 1);
      parts.push(b);
    }
  };
  const encode = v => {
    if (typeof v === "number" && Number.isInteger(v)) {
      if (v >= 0) head(0, v);
      else head(1, -1 - v);
    } else if (Buffer.isBuffer(v)) {
      head(2, v.length);
      parts.push(v);
    } else if (typeof v === "string") {
      const b = Buffer.from(v, "utf8");
      head(3, b.length);
      parts.push(b);
    } else if (Array.isArray(v)) {
      head(4, v.length);
      v.forEach(encode);
    } else if (v instanceof Map) {
      head(5, v.size);
      for (const [k, item] of v) {
        encode(k);
        encode(item);
      }
    } else {
      throw new TypeError("unsupported test CBOR value");
    }
  };
  encode(value);
  return Buffer.concat(parts);
}

// --- fixtures ---------------------------------------------------------------

function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = cborEncode(
    new Map([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x, "base64url")],
      [-3, Buffer.from(jwk.y, "base64url")],
    ]),
  );
  return { publicKey, privateKey, jwk, cose };
}

const u32 = n => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

function authDataBytes({ rpId = RP_ID, flags, signCount = 0, attested } = {}) {
  const head = Buffer.concat([createHash("sha256").update(rpId, "utf8").digest(), Buffer.from([flags]), u32(signCount)]);
  if (!attested) return head;
  const len = Buffer.alloc(2);
  len.writeUInt16BE(attested.credentialId.length);
  return Buffer.concat([head, attested.aaguid, len, attested.credentialId, attested.cose]);
}

const clientDataJSON = ({ type, challenge, origin = ORIGIN }) =>
  base64urlEncode(Buffer.from(JSON.stringify({ type, challenge, origin }), "utf8"));

function registrationResponse({ key, challenge, rpId = RP_ID, origin = ORIGIN, flags = 0x41, fmt = "none", attStmt = new Map(), signCount = 0, credentialId }) {
  const credId = credentialId ?? randomBytes(16);
  const authData = authDataBytes({
    rpId,
    flags,
    signCount,
    attested: { aaguid: Buffer.alloc(16), credentialId: credId, cose: key.cose },
  });
  const attObj = cborEncode(
    new Map([
      ["fmt", fmt],
      ["authData", authData],
      ["attStmt", attStmt],
    ]),
  );
  const id = base64urlEncode(credId);
  return {
    id,
    rawId: id,
    type: "public-key",
    response: {
      clientDataJSON: clientDataJSON({ type: WEBAUTHN_CREATE_TYPE, challenge, origin }),
      attestationObject: base64urlEncode(attObj),
    },
    transports: ["internal"],
    credentialId: credId,
  };
}

function authenticationAssertion({ key, challenge, rpId = RP_ID, origin = ORIGIN, flags = 0x01, signCount = 1, credentialId, userHandle, clientDataType = WEBAUTHN_GET_TYPE, tamperSignature = false }) {
  const authData = authDataBytes({ rpId, flags, signCount });
  const cdj = clientDataJSON({ type: clientDataType, challenge, origin });
  const data = Buffer.concat([authData, createHash("sha256").update(base64urlDecode(cdj)).digest()]);
  let signature = sign("sha256", data, { key: key.privateKey, dsaEncoding: "ieee-p1363" });
  if (tamperSignature) {
    signature = Buffer.from(signature);
    signature[0] ^= 0xff;
  }
  const id = base64urlEncode(credentialId);
  const response = {
    clientDataJSON: cdj,
    authenticatorData: base64urlEncode(authData),
    signature: base64urlEncode(signature),
  };
  if (userHandle !== undefined) response.userHandle = userHandle;
  return { id, rawId: id, type: "public-key", response };
}

const expectedFor = (challenge, overrides = {}) => ({ challenge, rpId: RP_ID, origin: ORIGIN, ...overrides });

function memoryStore() {
  const creds = new Map();
  return {
    getCredential: id => creds.get(id),
    saveCredential: record => {
      creds.set(record.id, record);
    },
    updateSignCount: (id, count) => {
      const record = creds.get(id);
      if (record) record.signCount = count;
    },
    size: () => creds.size,
  };
}

function registerHappy(key, challenge, overrides = {}) {
  const response = registrationResponse({ key, challenge, ...overrides });
  const record = verifyRegistrationResponse({
    response,
    expected: expectedFor(challenge, overrides.expectedOverrides),
    now: NOW,
  });
  return { response, record };
}

// --- base64url ---------------------------------------------------------------

test("base64url round-trips bytes", () => {
  for (const bytes of [Buffer.from([0]), Buffer.from("hello"), randomBytes(32), Buffer.alloc(32, 0xff)]) {
    assert.deepEqual(base64urlDecode(base64urlEncode(bytes)), bytes);
  }
  assert.equal(base64urlEncode(Buffer.from([0xfb, 0xef])), "--8");
});

test("base64urlDecode rejects bad input", () => {
  assert.throws(() => base64urlDecode("not valid!"), TypeError);
  assert.throws(() => base64urlDecode("a+b"), TypeError);
  assert.throws(() => base64urlDecode(42), TypeError);
});

// --- challenges --------------------------------------------------------------

test("generateChallenge uses the injected random source", () => {
  const deterministic = size => Buffer.alloc(size, 0x07);
  assert.equal(generateChallenge(32, { random: deterministic }), base64urlEncode(Buffer.alloc(32, 0x07)));
  assert.equal(generateChallenge(16, { random: deterministic }).length, 22);
  assert.throws(() => generateChallenge(0), RangeError);
});

test("default challenge is 32 random bytes", () => {
  const a = generateChallenge();
  const b = generateChallenge();
  assert.notEqual(a, b);
  assert.equal(base64urlDecode(a).length, CHALLENGE_BYTES);
});

test("issueChallenge / isChallengeFresh", () => {
  const record = issueChallenge({ random: size => Buffer.alloc(size, 1), now: NOW });
  assert.equal(record.issuedAt, NOW);
  assert.equal(record.expiresAt, NOW + 5 * 60 * 1000);
  assert.equal(isChallengeFresh(record, { now: NOW }), true);
  assert.equal(isChallengeFresh(record, { now: record.expiresAt + 1 }), false);
  assert.equal(isChallengeFresh(null), false);
  assert.equal(isChallengeFresh({ challenge: "x" }), false);
  assert.throws(() => issueChallenge({ ttlMs: 0 }), RangeError);
});

// --- options builders --------------------------------------------------------

test("createRegistrationOptions builds a valid ceremony payload", () => {
  const { options, challenge } = createRegistrationOptions({
    rpId: RP_ID,
    rpName: "Room",
    user: { id: "user-1", name: "ada", displayName: "Ada" },
    challenge: "fixed-challenge",
    excludeCredentials: [{ id: "abc", transports: ["usb"] }, "def"],
  });
  assert.equal(options.challenge, "fixed-challenge");
  assert.equal(challenge, "fixed-challenge");
  assert.deepEqual(options.rp, { id: RP_ID, name: "Room" });
  assert.equal(options.user.id, base64urlEncode(Buffer.from("user-1", "utf8")));
  assert.equal(options.user.name, "ada");
  assert.equal(options.attestation, "none");
  assert.deepEqual(options.excludeCredentials, [
    { type: "public-key", id: "abc", transports: ["usb"] },
    { type: "public-key", id: "def" },
  ]);
  assert.ok(options.pubKeyCredParams.some(p => p.alg === -7));
  assert.throws(() => createRegistrationOptions({ rpId: "", user: { id: "x", name: "y" } }), TypeError);
  assert.throws(() => createRegistrationOptions({ rpId: RP_ID, user: { id: "x" } }), TypeError);
});

test("createAuthenticationOptions builds a valid ceremony payload", () => {
  const { options, challenge } = createAuthenticationOptions({
    rpId: RP_ID,
    allowCredentials: [{ id: "abc" }],
    userVerification: "required",
  });
  assert.equal(options.rpId, RP_ID);
  assert.equal(options.userVerification, "required");
  assert.deepEqual(options.allowCredentials, [{ type: "public-key", id: "abc" }]);
  assert.equal(base64urlDecode(challenge).length, CHALLENGE_BYTES);
  assert.throws(() => createAuthenticationOptions({ rpId: "" }), TypeError);
});

// --- client data -------------------------------------------------------------

test("parseClientDataJSON rejects malformed input", () => {
  assert.throws(() => parseClientDataJSON("!!!"), TypeError);
  assert.throws(() => parseClientDataJSON(base64urlEncode(Buffer.from("[1,2", "utf8"))), TypeError);
  assert.throws(() => parseClientDataJSON(base64urlEncode(Buffer.from('"str"', "utf8"))), TypeError);
});

test("verifyClientData enforces type, challenge, origin", () => {
  const good = clientDataJSON({ type: WEBAUTHN_CREATE_TYPE, challenge: "c1", origin: ORIGIN });
  const parsed = verifyClientData({ clientDataJSON: good, expectedType: WEBAUTHN_CREATE_TYPE, expectedChallenge: "c1", expectedOrigin: ORIGIN });
  assert.equal(parsed.type, WEBAUTHN_CREATE_TYPE);
  assert.throws(
    () => verifyClientData({ clientDataJSON: good, expectedType: WEBAUTHN_GET_TYPE, expectedChallenge: "c1", expectedOrigin: ORIGIN }),
    /unexpected client data type/,
  );
  assert.throws(
    () => verifyClientData({ clientDataJSON: good, expectedType: WEBAUTHN_CREATE_TYPE, expectedChallenge: "other", expectedOrigin: ORIGIN }),
    /challenge mismatch/,
  );
  assert.throws(
    () => verifyClientData({ clientDataJSON: good, expectedType: WEBAUTHN_CREATE_TYPE, expectedChallenge: "c1", expectedOrigin: "https://evil.example" }),
    /unexpected origin/,
  );
});

// --- CBOR / authData / COSE ----------------------------------------------------

test("cborDecode handles the types WebAuthn needs", () => {
  assert.equal(cborDecode(cborEncode(42)), 42);
  assert.equal(cborDecode(cborEncode(-7)), -7);
  assert.deepEqual(cborDecode(cborEncode(Buffer.from([1, 2]))), Buffer.from([1, 2]));
  assert.equal(cborDecode(cborEncode("none")), "none");
  assert.deepEqual(cborDecode(cborEncode([1, "a"])), [1, "a"]);
  const map = cborDecode(cborEncode(new Map([["fmt", "none"], [-1, 1]])));
  assert.ok(map instanceof Map);
  assert.equal(map.get("fmt"), "none");
  assert.equal(map.get(-1), 1);
  assert.throws(() => cborDecode(Buffer.from([0x1f])), TypeError); // indefinite length
  assert.throws(() => cborDecode(Buffer.from([0x42, 0x01])), TypeError); // truncated
});

test("parseAuthData parses flags, counter, and attested data", () => {
  const credId = randomBytes(16);
  const key = makeKey();
  const bytes = authDataBytes({
    flags: 0x41,
    signCount: 7,
    attested: { aaguid: Buffer.alloc(16), credentialId: credId, cose: key.cose },
  });
  const parsed = parseAuthData(bytes);
  assert.equal(parsed.rpIdHash.length, 32);
  assert.equal(parsed.flags.userPresent, true);
  assert.equal(parsed.flags.userVerified, false);
  assert.equal(parsed.flags.attestedCredentialData, true);
  assert.equal(parsed.signCount, 7);
  assert.deepEqual(parsed.credentialId, credId);
  assert.deepEqual(parsed.credentialPublicKey, key.cose);
  assert.throws(() => parseAuthData(Buffer.alloc(10)), TypeError);
});

test("coseKeyToJwk converts ES256 and rejects the rest", () => {
  const key = makeKey();
  const jwk = coseKeyToJwk(key.cose);
  assert.deepEqual(jwk, { kty: "EC", crv: "P-256", x: key.jwk.x, y: key.jwk.y });
  const wrongAlg = cborEncode(new Map([[1, 2], [3, -257], [-1, 1], [-2, Buffer.alloc(32)], [-3, Buffer.alloc(32)]]));
  assert.throws(() => coseKeyToJwk(wrongAlg), RangeError);
  assert.throws(() => coseKeyToJwk(cborEncode("nope")), TypeError);
});

test("defaultVerifySignature verifies ES256 and never throws", () => {
  const key = makeKey();
  const data = Buffer.from("signed payload");
  const signature = sign("sha256", data, { key: key.privateKey, dsaEncoding: "ieee-p1363" });
  assert.equal(defaultVerifySignature({ publicKeyCose: key.cose, data, signature }), true);
  assert.equal(defaultVerifySignature({ publicKeyCose: key.cose, data: Buffer.from("other"), signature }), false);
  assert.equal(defaultVerifySignature({ publicKeyCose: key.cose, data, signature: Buffer.alloc(64) }), false);
  assert.equal(defaultVerifySignature({ publicKeyCose: Buffer.from([0x01]), data, signature }), false);
});

// --- registration verification ------------------------------------------------

test("registration happy path returns a storable credential record", () => {
  const key = makeKey();
  const challenge = generateChallenge(32, { random: size => Buffer.alloc(size, 3) });
  const { record } = registerHappy(key, challenge);
  assert.equal(typeof record.id, "string");
  assert.equal(record.rpId, RP_ID);
  assert.equal(record.fmt, "none");
  assert.deepEqual(record.publicKeyJwk, { kty: "EC", crv: "P-256", x: key.jwk.x, y: key.jwk.y });
  assert.deepEqual(base64urlDecode(record.publicKeyCose), key.cose);
  assert.equal(record.signCount, 0);
  assert.deepEqual(record.transports, ["internal"]);
  assert.equal(record.createdAt, NOW);
});

test("registration rejects tampered or expired challenges", () => {
  const key = makeKey();
  const challenge = "real-challenge";
  const response = registrationResponse({ key, challenge });
  assert.throws(
    () => verifyRegistrationResponse({ response, expected: expectedFor("other-challenge"), now: NOW }),
    /challenge mismatch/,
  );
  assert.throws(
    () => verifyRegistrationResponse({ response, expected: expectedFor(challenge, { expiresAt: NOW - 1 }), now: NOW }),
    /challenge expired/,
  );
  // Not yet expired still passes.
  const record = verifyRegistrationResponse({ response, expected: expectedFor(challenge, { expiresAt: NOW + 1000 }), now: NOW });
  assert.equal(record.rpId, RP_ID);
});

test("registration rejects wrong origin, wrong rpId, swapped ceremony type", () => {
  const key = makeKey();
  const challenge = "c-reg";
  assert.throws(
    () => registerHappy(key, challenge, { origin: "https://evil.example" }),
    /unexpected origin/,
  );
  assert.throws(
    () => registerHappy(key, challenge, { rpId: "other.example" }),
    /rpId hash mismatch/,
  );
  const response = registrationResponse({ key, challenge });
  response.response.clientDataJSON = clientDataJSON({ type: WEBAUTHN_GET_TYPE, challenge, origin: ORIGIN });
  assert.throws(
    () => verifyRegistrationResponse({ response, expected: expectedFor(challenge), now: NOW }),
    /unexpected client data type/,
  );
});

test("registration rejects missing user-presence flag and malformed attestation", () => {
  const key = makeKey();
  const challenge = "c-flags";
  assert.throws(() => registerHappy(key, challenge, { flags: 0x40 }), /user presence flag not set/);
  const response = registrationResponse({ key, challenge });
  response.response.attestationObject = base64urlEncode(cborEncode("not-a-map"));
  assert.throws(() => verifyRegistrationResponse({ response, expected: expectedFor(challenge), now: NOW }), TypeError);
  const badB64 = registrationResponse({ key, challenge });
  badB64.response.clientDataJSON = "!!!not-base64url!!!";
  assert.throws(() => verifyRegistrationResponse({ response: badB64, expected: expectedFor(challenge), now: NOW }), TypeError);
});

test("registration rejects non-none attestation without a verifier", () => {
  const key = makeKey();
  const challenge = "c-att";
  assert.throws(() => registerHappy(key, challenge, { fmt: "packed" }), /requires a verifier/);
  // Wiring-supplied verifier can accept it.
  const response = registrationResponse({ key, challenge, fmt: "packed" });
  const record = verifyRegistrationResponse({
    response,
    expected: expectedFor(challenge),
    now: NOW,
    attestationVerifier: ({ fmt }) => fmt === "packed",
  });
  assert.equal(record.fmt, "packed");
  assert.throws(
    () =>
      verifyRegistrationResponse({
        response,
        expected: expectedFor(challenge),
        now: NOW,
        attestationVerifier: () => false,
      }),
    /not verified/,
  );
});

test("registration rejects mismatched credential type", () => {
  const key = makeKey();
  const challenge = "c-type";
  const response = registrationResponse({ key, challenge });
  response.type = "not-public-key";
  assert.throws(() => verifyRegistrationResponse({ response, expected: expectedFor(challenge), now: NOW }), /unexpected credential type/);
});

// --- authentication verification ------------------------------------------------

test("authentication happy path verifies a real ES256 assertion", () => {
  const key = makeKey();
  const regChallenge = "reg-1";
  const { record } = registerHappy(key, regChallenge);
  const store = memoryStore();
  store.saveCredential(record);

  const authChallenge = "auth-1";
  const assertion = authenticationAssertion({ key, challenge: authChallenge, credentialId: record.credentialId ?? base64urlDecode(record.id), signCount: 1, userHandle: "user-1" });
  const result = verifyAuthenticationAssertion({
    assertion,
    expected: expectedFor(authChallenge),
    store,
    now: NOW,
  });
  assert.equal(result.credentialId, record.id);
  assert.equal(result.userHandle, "user-1");
  assert.equal(result.signCount, 1);
  assert.equal(store.getCredential(record.id).signCount, 1);
});

test("authentication rejects replayed assertions (counter does not advance)", () => {
  const key = makeKey();
  const { record } = registerHappy(key, "reg-replay");
  const store = memoryStore();
  store.saveCredential(record);
  const credentialId = base64urlDecode(record.id);

  const first = authenticationAssertion({ key, challenge: "auth-a", credentialId, signCount: 1 });
  verifyAuthenticationAssertion({ assertion: first, expected: expectedFor("auth-a"), store, now: NOW });

  // Same counter again: replay / clone.
  const replay = authenticationAssertion({ key, challenge: "auth-b", credentialId, signCount: 1 });
  assert.throws(
    () => verifyAuthenticationAssertion({ assertion: replay, expected: expectedFor("auth-b"), store, now: NOW }),
    /not greater than stored/,
  );
  // Counter going backwards also fails, and the store keeps the good value.
  const backwards = authenticationAssertion({ key, challenge: "auth-c", credentialId, signCount: 0 });
  assert.throws(
    () => verifyAuthenticationAssertion({ assertion: backwards, expected: expectedFor("auth-c"), store, now: NOW }),
    /not greater than stored/,
  );
  assert.equal(store.getCredential(record.id).signCount, 1);
});

test("authentication allows the 0/0 counter case (authenticator not counting)", () => {
  const key = makeKey();
  const { record } = registerHappy(key, "reg-zero");
  const store = memoryStore();
  store.saveCredential(record);
  const assertion = authenticationAssertion({ key, challenge: "auth-zero", credentialId: base64urlDecode(record.id), signCount: 0 });
  const result = verifyAuthenticationAssertion({ assertion, expected: expectedFor("auth-zero"), store, now: NOW });
  assert.equal(result.signCount, 0);
});

test("authentication rejects tampered signatures and leaves the store untouched", () => {
  const key = makeKey();
  const { record } = registerHappy(key, "reg-tamper");
  const store = memoryStore();
  store.saveCredential(record);
  const assertion = authenticationAssertion({
    key,
    challenge: "auth-tamper",
    credentialId: base64urlDecode(record.id),
    signCount: 5,
    tamperSignature: true,
  });
  assert.throws(
    () => verifyAuthenticationAssertion({ assertion, expected: expectedFor("auth-tamper"), store, now: NOW }),
    /signature invalid/,
  );
  assert.equal(store.getCredential(record.id).signCount, 0);
});

test("authentication rejects wrong origin, challenge, rpId, and ceremony type", () => {
  const key = makeKey();
  const { record } = registerHappy(key, "reg-neg");
  const store = memoryStore();
  store.saveCredential(record);
  const credentialId = base64urlDecode(record.id);
  const base = { key, credentialId, signCount: 1 };

  assert.throws(
    () => verifyAuthenticationAssertion({ assertion: authenticationAssertion({ ...base, challenge: "a1", origin: "https://evil.example" }), expected: expectedFor("a1"), store, now: NOW }),
    /unexpected origin/,
  );
  assert.throws(
    () => verifyAuthenticationAssertion({ assertion: authenticationAssertion({ ...base, challenge: "real" }), expected: expectedFor("other"), store, now: NOW }),
    /challenge mismatch/,
  );
  assert.throws(
    () => verifyAuthenticationAssertion({ assertion: authenticationAssertion({ ...base, challenge: "a2", rpId: "other.example" }), expected: expectedFor("a2"), store, now: NOW }),
    /rpId hash mismatch/,
  );
  assert.throws(
    () => verifyAuthenticationAssertion({ assertion: authenticationAssertion({ ...base, challenge: "a3", clientDataType: WEBAUTHN_CREATE_TYPE }), expected: expectedFor("a3"), store, now: NOW }),
    /unexpected client data type/,
  );
  assert.throws(
    () => verifyAuthenticationAssertion({ assertion: authenticationAssertion({ ...base, challenge: "a4" }), expected: expectedFor("a4", { expiresAt: NOW - 1 }), store, now: NOW }),
    /challenge expired/,
  );
});

test("authentication rejects unknown credentials, missing flags, and rpId mismatch", () => {
  const key = makeKey();
  const { record } = registerHappy(key, "reg-unk");
  const store = memoryStore();
  store.saveCredential(record);

  const stranger = authenticationAssertion({ key, challenge: "s1", credentialId: randomBytes(16), signCount: 1 });
  assert.throws(
    () => verifyAuthenticationAssertion({ assertion: stranger, expected: expectedFor("s1"), store, now: NOW }),
    /unknown credential/,
  );

  const noUp = authenticationAssertion({ key, challenge: "s2", credentialId: base64urlDecode(record.id), signCount: 1, flags: 0x00 });
  assert.throws(
    () => verifyAuthenticationAssertion({ assertion: noUp, expected: expectedFor("s2"), store, now: NOW }),
    /user presence flag not set/,
  );

  const noUv = authenticationAssertion({ key, challenge: "s3", credentialId: base64urlDecode(record.id), signCount: 2, flags: 0x01 });
  assert.throws(
    () => verifyAuthenticationAssertion({ assertion: noUv, expected: expectedFor("s3"), store, now: NOW, requireUserVerification: true }),
    /user verification required/,
  );
  const withUv = authenticationAssertion({ key, challenge: "s4", credentialId: base64urlDecode(record.id), signCount: 3, flags: 0x05 });
  const result = verifyAuthenticationAssertion({ assertion: withUv, expected: expectedFor("s4"), store, now: NOW, requireUserVerification: true });
  assert.equal(result.signCount, 3);
});

test("authentication rejects a credential record from a different rpId", () => {
  const key = makeKey();
  // Credential registered under other.example; assertion rpIdHash will not
  // match this room's rpId, so verification must fail before the store.
  const response = registrationResponse({ key, challenge: "reg-rp2", rpId: "other.example" });
  const other = verifyRegistrationResponse({ response, expected: expectedFor("reg-rp2", { rpId: "other.example" }), now: NOW });
  const store = memoryStore();
  store.saveCredential(other);
  const assertion = authenticationAssertion({ key, challenge: "x1", rpId: "other.example", credentialId: base64urlDecode(other.id), signCount: 1 });
  assert.throws(
    () => verifyAuthenticationAssertion({ assertion, expected: expectedFor("x1"), store, now: NOW }),
    /rpId hash mismatch/,
  );
});

test("authentication validates inputs and never touches the store on failure", () => {
  const store = memoryStore();
  assert.throws(
    () => verifyAuthenticationAssertion({ assertion: null, expected: expectedFor("c"), store, now: NOW }),
    TypeError,
  );
  assert.throws(
    () => verifyAuthenticationAssertion({ assertion: {}, expected: expectedFor("c"), store: {}, now: NOW }),
    /store.getCredential/,
  );
  const bad = { id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: "!!!", authenticatorData: "eA", signature: "eA" } };
  assert.throws(
    () => verifyAuthenticationAssertion({ assertion: bad, expected: expectedFor("c"), store, now: NOW }),
    TypeError,
  );
  assert.equal(store.size(), 0);
});

test("custom verifySignature hook is honored", () => {
  const key = makeKey();
  const { record } = registerHappy(key, "reg-hook");
  const store = memoryStore();
  store.saveCredential(record);
  const assertion = authenticationAssertion({ key, challenge: "h1", credentialId: base64urlDecode(record.id), signCount: 1 });
  assert.throws(
    () =>
      verifyAuthenticationAssertion({
        assertion,
        expected: expectedFor("h1"),
        store,
        now: NOW,
        verifySignature: () => false,
      }),
    /signature invalid/,
  );
  const result = verifyAuthenticationAssertion({
    assertion,
    expected: expectedFor("h1"),
    store,
    now: NOW,
    verifySignature: ({ data }) => Buffer.isBuffer(data),
  });
  assert.equal(result.signCount, 1);
});
