import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPushRequest,
  constants,
  decryptContent,
  encryptContent,
  encryptPushPayload,
  fromBase64Url,
  generateVapidKeys,
  hkdfExpand,
  hkdfExtract,
  toBase64Url,
  vapidAuthorization
} from "../server/web-push.mjs";

// The point of this file is that the crypto is checked against bytes published
// by somebody else. A push payload that only round-trips through its own
// encryptor proves nothing: the receiver is a browser we do not control, and a
// derivation that is self-consistently wrong still fails silently in the field,
// with no error anywhere to read.
//
// Two kinds of check, because the two RFCs admit different amounts of latitude:
//   * Reproduce. RFC 8188 section 3.1 and RFC 8291 section 5 fix every input,
//     so our output must equal theirs octet for octet, intermediates included.
//   * Read back. RFC 8188 section 3.2 exercises optional zero padding, which a
//     correct encoder may decline to emit, so matching its bytes would only
//     prove we copied its taste. Decrypting it proves the parts that must
//     interoperate: header parse, record boundaries, per-record nonce, and the
//     delimiter-then-padding trailer.
//
// Vectors from:
//   RFC 8188, Encrypted Content-Encoding for HTTP, sections 3.1 and 3.2
//   RFC 8291, Message Encryption for Web Push, section 5

const utf8 = new TextEncoder();
const bytes = value => fromBase64Url(value);

test("RFC 8188 section 3.1: a single aes128gcm record matches the published body", async () => {
  const { body } = await encryptContent({
    plaintext: utf8.encode("I am the walrus"),
    inputKeyMaterial: bytes("yqdlZ-tYemfogSmv7Ws5PQ"),
    salt: bytes("I1BsxtFttlv3u_Oo94xnmw"),
    keyid: new Uint8Array(0),
    recordSize: 4096
  });

  assert.equal(toBase64Url(body), "I1BsxtFttlv3u_Oo94xnmwAAEAAA-NAVub2qFgBEuQKRapoZu-IxkIva3MEB1PD-ly8Thjg");
});

test("RFC 8188 section 3.2: the published multi-record body decrypts, proving nonce sequence and padding handling", async () => {
  // This vector is checked by reading it, not by reproducing it. Its rs is 25
  // and the RFC splits the message 7 octets then 8, with one 0x00 padding octet
  // in the first record - padding is optional in RFC 8188 and exists to blunt
  // traffic analysis, so a padding-free encoder that is perfectly correct still
  // emits different bytes. Decrypting is the part that has to interoperate: it
  // exercises the header parse, the record boundary, the per-record nonce and
  // the delimiter-then-padding trailer, all against somebody else's output.
  const published = "uNCkWiNYzKTnBN9ji3-qWAAAABkCYTHOG8chz_gnvgOqdGYovxyjuqRyJFjEDyoF1Fvkj6hQPdPHI51OEUKEpgz3SsLWIqS_uA";

  const read = await decryptContent({ body: bytes(published), inputKeyMaterial: bytes("BO3ZVPxUlnLORbVGMpbT1Q") });

  assert.equal(new TextDecoder().decode(read.plaintext), "I am the walrus");
  assert.equal(read.records, 2, "the message spans two records");
  assert.equal(read.recordSize, 25);
  assert.equal(new TextDecoder().decode(read.keyid), "a1");
});

test("RFC 8188 section 3.1: the published single-record body also decrypts", async () => {
  const read = await decryptContent({
    body: bytes("I1BsxtFttlv3u_Oo94xnmwAAEAAA-NAVub2qFgBEuQKRapoZu-IxkIva3MEB1PD-ly8Thjg"),
    inputKeyMaterial: bytes("yqdlZ-tYemfogSmv7Ws5PQ")
  });
  assert.equal(new TextDecoder().decode(read.plaintext), "I am the walrus");
  assert.equal(read.records, 1);
  assert.equal(read.keyid.length, 0);
});

test("our own multi-record output round-trips, including a body that spans many records", async () => {
  const ikm = bytes("BO3ZVPxUlnLORbVGMpbT1Q");
  const salt = bytes("uNCkWiNYzKTnBN9ji3-qWA");
  // 300 octets at rs=25 is 8 plaintext octets per record: 38 records. Enough to
  // catch a nonce counter that stops advancing after the first few.
  const message = "walrus ".repeat(43).slice(0, 300);
  const { body } = await encryptContent({ plaintext: utf8.encode(message), inputKeyMaterial: ikm, salt, keyid: utf8.encode("a1"), recordSize: 25 });
  const read = await decryptContent({ body, inputKeyMaterial: ikm });
  assert.equal(new TextDecoder().decode(read.plaintext), message);
  assert.equal(read.records, Math.ceil(300 / 8));
});

test("a tampered or truncated body is refused rather than returning partial plaintext", async () => {
  const ikm = bytes("yqdlZ-tYemfogSmv7Ws5PQ");
  const published = bytes("I1BsxtFttlv3u_Oo94xnmwAAEAAA-NAVub2qFgBEuQKRapoZu-IxkIva3MEB1PD-ly8Thjg");

  const flipped = Uint8Array.from(published);
  flipped[flipped.length - 1] ^= 0x01;
  await assert.rejects(() => decryptContent({ body: flipped, inputKeyMaterial: ikm }), /web_push_record_authentication_failed/);

  await assert.rejects(
    () => decryptContent({ body: published.subarray(0, published.length - 8), inputKeyMaterial: ikm }),
    /web_push_record_authentication_failed/
  );
  await assert.rejects(() => decryptContent({ body: published.subarray(0, 12), inputKeyMaterial: ikm }), /web_push_body_truncated/);
  await assert.rejects(
    () => decryptContent({ body: published, inputKeyMaterial: bytes("BO3ZVPxUlnLORbVGMpbT1Q") }),
    /web_push_record_authentication_failed/,
    "the wrong key must fail closed"
  );
});

test("RFC 8291 section 5: the web push example reproduces every intermediate and the final body", async () => {
  const receiverPublic = bytes("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
  const senderPublic = bytes("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");

  const result = await encryptPushPayload({
    payload: utf8.encode("When I grow up, I want to be a watermelon"),
    userAgentPublicKey: receiverPublic,
    authSecret: bytes("BTBZMqHH6r4Tts7J_aSIgg"),
    senderKeys: { publicKey: senderPublic, privateKey: bytes("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw") },
    salt: bytes("DGv6ra1nlYgDCS1FRnbzlw")
  });

  // Each intermediate is pinned separately so a regression names the step that
  // broke rather than only the final mismatch.
  assert.equal(toBase64Url(result.ecdhSecret), "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs", "ecdh_secret");
  assert.equal(toBase64Url(result.prkKey), "Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k", "PRK_key");
  assert.equal(toBase64Url(result.inputKeyMaterial), "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg", "IKM");
  assert.equal(toBase64Url(result.prk), "09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc", "PRK");
  assert.equal(toBase64Url(result.contentEncryptionKey), "oIhVW04MRdy2XN9CiKLxTg", "CEK");
  assert.equal(toBase64Url(result.nonce), "4h_95klXJ5E_qnoN", "NONCE");

  assert.equal(
    toBase64Url(result.body),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
  );
});

// The RFC vectors fix one path through the code. The rest of this file covers
// the ways a real deployment differs from the example.

test("the encrypted header carries the salt, record size and sender key the receiver needs", async () => {
  const receiverPublic = bytes("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
  const result = await encryptPushPayload({
    payload: utf8.encode("hello"),
    userAgentPublicKey: receiverPublic,
    authSecret: bytes("BTBZMqHH6r4Tts7J_aSIgg")
  });

  const header = result.body.subarray(0, 21);
  assert.deepEqual(header.subarray(0, 16), result.salt, "salt is the first 16 octets");
  assert.equal(new DataView(header.buffer, header.byteOffset).getUint32(16, false), constants.DEFAULT_RECORD_SIZE, "record size");
  assert.equal(header[20], constants.P256_PUBLIC_BYTES, "keyid length is the uncompressed point length");
  assert.deepEqual(result.body.subarray(21, 21 + 65), result.senderPublicKey, "keyid is the sender public key");
});

test("a fresh ephemeral key and salt are used for every message", async () => {
  const receiverPublic = bytes("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
  const send = () => encryptPushPayload({
    payload: utf8.encode("same text"),
    userAgentPublicKey: receiverPublic,
    authSecret: bytes("BTBZMqHH6r4Tts7J_aSIgg")
  });

  const [first, second] = await Promise.all([send(), send()]);
  assert.notDeepEqual(first.senderPublicKey, second.senderPublicKey, "ephemeral key must not repeat");
  assert.notDeepEqual(first.salt, second.salt, "salt must not repeat");
  assert.notDeepEqual(first.body, second.body, "identical plaintext must not produce identical ciphertext");
});

test("an empty payload still produces one record, so the end marker is always present", async () => {
  const { body } = await encryptContent({
    plaintext: new Uint8Array(0),
    inputKeyMaterial: bytes("yqdlZ-tYemfogSmv7Ws5PQ"),
    salt: bytes("I1BsxtFttlv3u_Oo94xnmw"),
    keyid: new Uint8Array(0)
  });
  // 21 header octets, then a single record of one delimiter octet plus the tag.
  assert.equal(body.length, 21 + 1 + 16);
});

test("a body that exactly fills its records adds no empty trailing record", async () => {
  // rs=18 is the floor: one plaintext octet plus the delimiter plus the tag. Two
  // octets fill two records exactly, and the second already carries the 0x02 end
  // marker, so a third record would be wasted bytes on every message.
  const ikm = bytes("yqdlZ-tYemfogSmv7Ws5PQ");
  const { body } = await encryptContent({
    plaintext: utf8.encode("ab"),
    inputKeyMaterial: ikm,
    salt: bytes("I1BsxtFttlv3u_Oo94xnmw"),
    keyid: new Uint8Array(0),
    recordSize: 18
  });
  assert.equal(body.length, 21 + 2 * 18, "two records, no filler");
  const read = await decryptContent({ body, inputKeyMaterial: ikm });
  assert.equal(new TextDecoder().decode(read.plaintext), "ab", "and it still reads back whole");
});

test("hkdf expands past one hash block", async () => {
  // RFC 5869 A.1 uses 42 octets, longer than one SHA-256 block, which exercises
  // the counter loop rather than the single-block shortcut.
  const prk = await hkdfExtract(new Uint8Array(13).fill(0x0c), new Uint8Array(22).fill(0x0b));
  const out = await hkdfExpand(prk, new Uint8Array(0), 42);
  assert.equal(out.length, 42);
  const short = await hkdfExpand(prk, new Uint8Array(0), 32);
  assert.deepEqual(out.subarray(0, 32), short, "the first block must not change with the requested length");
});

test("malformed subscription material is refused rather than encrypted into nonsense", async () => {
  const receiverPublic = bytes("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
  const auth = bytes("BTBZMqHH6r4Tts7J_aSIgg");

  await assert.rejects(
    () => encryptPushPayload({ payload: utf8.encode("x"), userAgentPublicKey: receiverPublic.subarray(0, 64), authSecret: auth }),
    /web_push_public_key_invalid/
  );
  await assert.rejects(
    () => encryptPushPayload({ payload: utf8.encode("x"), userAgentPublicKey: receiverPublic, authSecret: auth.subarray(0, 12) }),
    /web_push_auth_secret_invalid/
  );
  // A compressed point is a valid P-256 encoding but not the one RFC 8291 uses.
  const compressed = new Uint8Array(65);
  compressed.set(receiverPublic);
  compressed[0] = 0x02;
  await assert.rejects(
    () => encryptPushPayload({ payload: utf8.encode("x"), userAgentPublicKey: compressed, authSecret: auth }),
    /web_push_public_key_invalid/
  );
  await assert.rejects(
    () => encryptContent({ plaintext: utf8.encode("x"), inputKeyMaterial: auth, salt: auth.subarray(0, 8), keyid: new Uint8Array(0) }),
    /web_push_salt_invalid/
  );
  await assert.rejects(
    () => encryptContent({ plaintext: utf8.encode("x"), inputKeyMaterial: auth, salt: bytes("I1BsxtFttlv3u_Oo94xnmw"), recordSize: 17 }),
    /web_push_record_size_invalid/
  );
});

test("the VAPID token is a verifiable ES256 JWT over the push service origin", async () => {
  const keys = await generateVapidKeys();
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);
  const { authorization, token } = await vapidAuthorization({
    endpoint: "https://fcm.googleapis.com/fcm/send/abcdef?query=ignored",
    subject: "mailto:ops@example.com",
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    lifetimeSeconds: 3600,
    now
  });

  assert.match(authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  const [header, claims, signature] = token.split(".");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fromBase64Url(header))), { typ: "JWT", alg: "ES256" });
  const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(claims)));
  assert.equal(payload.aud, "https://fcm.googleapis.com", "audience is the origin only, never the full endpoint");
  assert.equal(payload.sub, "mailto:ops@example.com");
  assert.equal(payload.exp, Math.floor(now / 1000) + 3600);
  assert.equal(fromBase64Url(signature).length, 64, "ES256 signatures are raw r||s, not DER");

  // Verify with the published public key, the way a push service does.
  const verifyKey = await crypto.subtle.importKey(
    "raw", fromBase64Url(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, verifyKey, fromBase64Url(signature), utf8.encode(`${header}.${claims}`)
  );
  assert.equal(ok, true, "signature must verify under the key advertised in k=");
});

test("VAPID refuses the inputs a push service would reject anyway", async () => {
  const keys = await generateVapidKeys();
  const base = { subject: "mailto:ops@example.com", publicKey: keys.publicKey, privateKey: keys.privateKey };
  await assert.rejects(() => vapidAuthorization({ ...base, endpoint: "http://push.example/x" }), /web_push_endpoint_not_https/);
  await assert.rejects(() => vapidAuthorization({ ...base, endpoint: "not a url" }), /web_push_endpoint_invalid/);
  await assert.rejects(() => vapidAuthorization({ ...base, endpoint: "https://push.example/x", subject: "ops@example.com" }), /web_push_vapid_subject_invalid/);
  // RFC 8292 caps the token lifetime at 24 hours; a longer one is rejected by
  // the service, which reads as a silent delivery failure.
  await assert.rejects(
    () => vapidAuthorization({ ...base, endpoint: "https://push.example/x", lifetimeSeconds: constants.MAX_VAPID_LIFETIME_SECONDS + 1 }),
    /web_push_vapid_lifetime_too_long/
  );
});

test("buildPushRequest describes the request without sending it", async () => {
  const keys = await generateVapidKeys();
  const subscription = {
    endpoint: "https://push.example.com/send/xyz",
    keys: {
      p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "BTBZMqHH6r4Tts7J_aSIgg"
    }
  };

  const request = await buildPushRequest({
    subscription,
    payload: JSON.stringify({ kind: "mention", roomId: "commons" }),
    vapid: { subject: "mailto:ops@example.com", publicKey: keys.publicKey, privateKey: keys.privateKey },
    ttlSeconds: 600,
    urgency: "high",
    topic: "commons-mention"
  });

  assert.equal(request.url, subscription.endpoint);
  assert.equal(request.method, "POST");
  assert.equal(request.headers["Content-Encoding"], "aes128gcm");
  assert.equal(request.headers.TTL, "600");
  assert.equal(request.headers.Urgency, "high");
  assert.equal(request.headers.Topic, "commons-mention");
  assert.equal(request.headers["Content-Length"], String(request.body.length));
  assert.match(request.headers.Authorization, /^vapid t=/);
  assert.ok(request.body instanceof Uint8Array && request.body.length > 21);
});

test("a payload-free wake carries no content headers", async () => {
  const request = await buildPushRequest({
    subscription: { endpoint: "https://push.example.com/send/xyz" },
    payload: null
  });
  assert.equal(request.body, undefined);
  assert.equal(request.headers["Content-Encoding"], undefined, "nothing was encrypted, so do not claim an encoding");
  assert.equal(request.headers["Content-Type"], undefined);
  assert.equal(request.headers.Authorization, undefined, "VAPID is optional and absent here");
});

test("buildPushRequest refuses a payload it cannot encrypt", async () => {
  await assert.rejects(
    () => buildPushRequest({ subscription: { endpoint: "https://push.example.com/x" }, payload: "hi" }),
    /web_push_subscription_keys_required/,
    "a subscription without keys must fail loudly, not send plaintext"
  );
  await assert.rejects(() => buildPushRequest({ subscription: {}, payload: null }), /web_push_endpoint_required/);
  await assert.rejects(
    () => buildPushRequest({ subscription: { endpoint: "https://push.example.com/x" }, payload: null, topic: "not valid!" }),
    /web_push_topic_invalid/
  );
});

test("base64url round-trips and rejects input that is not base64url", () => {
  const sample = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(fromBase64Url(toBase64Url(sample)), sample);
  assert.equal(toBase64Url(new Uint8Array(0)), "");
  assert.ok(!toBase64Url(sample).includes("+") && !toBase64Url(sample).includes("/") && !toBase64Url(sample).includes("="));
  assert.throws(() => fromBase64Url("not*base64"), /web_push_base64url_invalid/);
  assert.throws(() => fromBase64Url(null), /web_push_base64url_expected_string/);
});
