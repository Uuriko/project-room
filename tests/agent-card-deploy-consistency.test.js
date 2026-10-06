// Deploy-time agent-card consistency (#1524).
//
// QA-b's production probes saw /.well-known/agent-card.json signed on 1 of 15
// fetches and unsigned on the other 14. The serve path bakes the signature at
// build time (deploy/agent-card-signed.mjs) and attaches it only when
// AGENT_CARD_SIGNED_REVISION === deployed.revision, so a single process can
// never flap per request — the observed flap means mixed versions behind the
// URL (gradual Worker rollout / traffic split). The post-deploy smoke
// (scripts/prod-deploy-smoke.mjs) never checked the card, so the flapping
// deploy passed silently. These tests pin the smoke's consistency check:
// every fetched card must be signed and verify against the pinned key, and a
// mixed signed/unsigned fetch sequence must fail the door check.
import test from "node:test";
import assert from "node:assert/strict";
import { checkAgentCard, checkAgentCardDoor } from "../scripts/prod-deploy-smoke.mjs";
import {
  generateKeyPair,
  signCard,
  signCardJws,
} from "../server/agent-card-signing.mjs";

const AGENT_ID = "project-room";
const KEY_ID = "test-card-key-1524";
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const JKU = "https://example.test/.well-known/jwks.json";

const keyPair = generateKeyPair();

// Mirror the production build order (scripts/sign-agent-card.mjs): sign the
// bare card, attach the envelope, then mint the JWS over card+envelope.
// Envelope fields are assigned directly (instead of via
// attachCardSignatureEnvelope, which hardcodes the production pinned key)
// so the fixture uses the test keypair end to end.
// `deployed` mirrors the served card, which names its own build
// (deploy/agent-discovery.mjs deployedInfo()); omit it to model older cards.
const buildSignedCard = (revision = REVISION, { deployed = false } = {}) => {
  const card = {
    name: "Test Room",
    description: "consistency fixture",
    url: null,
    capabilities: { streaming: false },
    skills: [],
    version: "1",
    ...(deployed ? { deployed: { revision } } : {}),
  };
  const signature = signCard({ agentId: AGENT_ID, card, privateKey: keyPair.privateKey });
  const withEnvelope = {
    ...card,
    keyId: KEY_ID,
    signatureAgentId: AGENT_ID,
    publicKey: keyPair.publicKey,
    cardSignature: signature,
    signedRevision: revision,
  };
  withEnvelope.signatures = [
    signCardJws({ card: withEnvelope, privateKey: keyPair.privateKey, keyId: KEY_ID, jku: JKU }),
  ];
  return withEnvelope;
};

const opts = { expectedRevision: REVISION, publicKey: keyPair.publicKey, keyId: KEY_ID, agentId: AGENT_ID };

test("checkAgentCard accepts a signed card whose signature verifies", () => {
  assert.deepEqual(checkAgentCard({ card: buildSignedCard(), ...opts }), []);
});

test("checkAgentCard rejects an unsigned card (signed:false, no signature fields)", () => {
  const failures = checkAgentCard({ card: { signed: false, name: "x" }, ...opts });
  assert.ok(failures.length > 0, "expected failures");
  assert.ok(failures.some(f => f.includes("signed:false")), `got: ${failures.join("; ")}`);
  assert.ok(failures.some(f => f.includes("cardSignature")), `got: ${failures.join("; ")}`);
});

test("checkAgentCard rejects a signature bound to a different revision", () => {
  const card = buildSignedCard();
  const failures = checkAgentCard({ card, ...opts, expectedRevision: "ffffffffffffffffffffffffffffffffffffffff" });
  assert.ok(failures.some(f => f.includes("signedRevision")), `got: ${failures.join("; ")}`);
});

test("checkAgentCard rejects a tampered card body", () => {
  const card = buildSignedCard();
  card.name = "Impostor Room";
  const failures = checkAgentCard({ card, ...opts });
  assert.ok(failures.some(f => f.includes("does not verify")), `got: ${failures.join("; ")}`);
});

test("checkAgentCard rejects a card missing the JWS signatures array", () => {
  const card = buildSignedCard();
  delete card.signatures;
  const failures = checkAgentCard({ card, ...opts });
  assert.ok(failures.some(f => f.includes("signatures")), `got: ${failures.join("; ")}`);
});

test("checkAgentCard rejects a card verified against the wrong pinned key", () => {
  const other = generateKeyPair();
  const failures = checkAgentCard({ card: buildSignedCard(), ...opts, publicKey: other.publicKey });
  assert.ok(failures.length > 0, "expected failures");
  assert.ok(failures.some(f => f.includes("pinned key")), `got: ${failures.join("; ")}`);
});

test("checkAgentCard rejects a broken second JWS even when the first verifies (room seq 3239, TB-14 carry-over)", () => {
  const card = buildSignedCard();
  // Prod cards carry two JWS entries (house + JWS both verify, 50/50 fetches
  // seen at 0172ecd5). The JWS payload drops `signatures`, so a second entry
  // minted over the same card verifies independently.
  const second = signCardJws({ card, privateKey: keyPair.privateKey, keyId: KEY_ID, jku: JKU });
  card.signatures = [card.signatures[0], second];
  // Sanity: both valid entries pass — the loop must not flag a good second.
  assert.deepEqual(checkAgentCard({ card, ...opts }), []);
  // Break only the second entry. The corruption flips the FIRST base64url
  // character (it encodes six full data bits, so the decoded bytes are
  // guaranteed to differ — flipping the last character is not enough, its
  // low bits are padding). The pre-fix check verified signatures[0] alone,
  // so this passed silently; every entry must be verified.
  const sig = second.signature;
  const broken = { ...second, signature: (sig[0] === "A" ? "B" : "A") + sig.slice(1) };
  card.signatures = [card.signatures[0], broken];
  const failures = checkAgentCard({ card, ...opts });
  assert.ok(
    failures.some(f => f.includes("signatures[1]") && f.includes("does not verify")),
    `got: ${failures.join("; ")}`,
  );
});

test("checkAgentCardDoor passes when every fetch is signed and verifying", async () => {
  const body = JSON.stringify(buildSignedCard());
  const get = async () => ({ status: 200, json: JSON.parse(body), ms: 1 });
  const failures = await checkAgentCardDoor({
    url: "https://example.test/.well-known/agent-card.json",
    fetches: 4, gapMs: 0, get, ...opts,
  });
  assert.deepEqual(failures, []);
});

// Fake clock for the propagation window: sleep advances time, nothing waits.
const fakeClock = () => {
  let t = 0;
  return { now: () => t, sleep: async ms => { t += ms; } };
};
const PREVIOUS = "b187c345c6c2ec468c0752614fc706c269b97bcf";
const doorUrl = "https://example.test/.well-known/agent-card.json";
const sequence = bodies => {
  let n = 0;
  const get = async () => {
    const body = bodies(++n);
    return { status: 200, json: JSON.parse(body), ms: 1 };
  };
  return { get, count: () => n };
};

test("checkAgentCardDoor fails when the fetch sequence flaps signed/unsigned (#1524)", async () => {
  const signed = JSON.stringify(buildSignedCard());
  const unsigned = JSON.stringify({ signed: false, name: "x" });
  // 1 signed fetch in 15, like the QA-b production observation — forever.
  const seq = sequence(n => (n % 15 === 7 ? signed : unsigned));
  const clock = fakeClock();
  const stats = {};
  const failures = await checkAgentCardDoor({
    url: doorUrl, fetches: 10, gapMs: 1500, waitMs: 90000, get: seq.get, ...clock, ...opts, stats,
  });
  assert.ok(failures.length > 0, "expected the flapping sequence to fail");
  assert.ok(failures.some(f => f.includes("signed:false")), `got: ${failures.join("; ")}`);
  assert.ok(failures.at(-1).startsWith("not converged"), `got: ${failures.at(-1)}`);
  assert.equal(stats.converged, false);
  assert.ok(clock.now() >= 90000, "the door used the whole window before failing");
  // The lone signed fetch never counts as a converged door.
  assert.ok(stats.attempts > 15);
});

test("checkAgentCardDoor tolerates a previous build still propagating, then converges (run 37392991641)", async () => {
  const fresh = JSON.stringify(buildSignedCard(REVISION, { deployed: true }));
  const stale = JSON.stringify(buildSignedCard(PREVIOUS, { deployed: true }));
  // Production: fetches #1-#6 carried the previous build's (validly signed) card.
  const seq = sequence(n => (n <= 6 ? stale : fresh));
  const stats = {};
  const failures = await checkAgentCardDoor({
    url: doorUrl, fetches: 10, gapMs: 1500, waitMs: 90000, get: seq.get, ...fakeClock(), ...opts, stats,
  });
  assert.deepEqual(failures, []);
  assert.equal(stats.converged, true);
  assert.equal(stats.staleFetches, 6);
  // Ten consecutive passing fetches AFTER the last stale one.
  assert.equal(seq.count(), 16);
});

test("checkAgentCardDoor resets the streak when a stale card reappears", async () => {
  const fresh = JSON.stringify(buildSignedCard(REVISION, { deployed: true }));
  const stale = JSON.stringify(buildSignedCard(PREVIOUS, { deployed: true }));
  const seq = sequence(n => (n === 1 || n === 4 ? stale : fresh));
  const failures = await checkAgentCardDoor({
    url: doorUrl, fetches: 5, gapMs: 1500, waitMs: 90000, get: seq.get, ...fakeClock(), ...opts,
  });
  assert.deepEqual(failures, []);
  // #2-#3 pass, #4 stale resets, #5-#9 are the five consecutive passes.
  assert.equal(seq.count(), 9);
});

test("checkAgentCardDoor fails a persistent previous-build card once the window closes", async () => {
  const stale = JSON.stringify(buildSignedCard(PREVIOUS, { deployed: true }));
  const seq = sequence(() => stale);
  const clock = fakeClock();
  const stats = {};
  const failures = await checkAgentCardDoor({
    url: doorUrl, fetches: 10, gapMs: 1500, waitMs: 90000, get: seq.get, ...clock, ...opts, stats,
  });
  assert.ok(failures.some(f => f.includes(`signedRevision "${PREVIOUS}" does not match deployed revision ${REVISION}`)), `got: ${failures.join("; ")}`);
  assert.ok(failures.at(-1).startsWith("not converged"), `got: ${failures.at(-1)}`);
  assert.equal(stats.converged, false);
  assert.ok(clock.now() >= 90000 && clock.now() < 90000 + 1500 * 2);
});

test("checkAgentCardDoor fails at once when the target build serves a bad card (no retry)", async () => {
  const card = buildSignedCard(REVISION, { deployed: true });
  card.name = "Impostor Room"; // signature no longer verifies
  const tampered = JSON.stringify(card);
  const seq = sequence(() => tampered);
  const failures = await checkAgentCardDoor({
    url: doorUrl, fetches: 10, gapMs: 1500, waitMs: 90000, get: seq.get, ...fakeClock(), ...opts,
  });
  assert.equal(seq.count(), 1, "a broken card from the new build must not be retried");
  assert.ok(failures.some(f => f.startsWith("fetch #1:") && f.includes("does not verify")), `got: ${failures.join("; ")}`);
});

test("checkAgentCardDoor fails at once when the target build serves an unsigned card", async () => {
  const unsigned = JSON.stringify({ signed: false, name: "x", deployed: { revision: REVISION } });
  const seq = sequence(() => unsigned);
  const failures = await checkAgentCardDoor({
    url: doorUrl, fetches: 10, gapMs: 1500, waitMs: 90000, get: seq.get, ...fakeClock(), ...opts,
  });
  assert.equal(seq.count(), 1);
  assert.ok(failures.some(f => f.includes("signed:false")), `got: ${failures.join("; ")}`);
});

test("checkAgentCardDoor: a uniformly good but slow door still passes after the window (no false rollback)", async () => {
  const fresh = JSON.stringify(buildSignedCard(REVISION, { deployed: true }));
  const clock = fakeClock();
  const seq = sequence(() => fresh);
  const slowGet = async url => { await clock.sleep(15000); return seq.get(url); };
  const stats = {};
  const failures = await checkAgentCardDoor({ url: doorUrl, fetches: 10, gapMs: 1500, waitMs: 90000, get: slowGet, ...clock, ...opts, stats });
  assert.deepEqual(failures, []);
  assert.equal(stats.converged, true);
  assert.ok(clock.now() > 90000);
});

test("checkAgentCardDoor: a streak that completes after the window following stale cards fails (room seq 3465)", async () => {
  const fresh = JSON.stringify(buildSignedCard(REVISION, { deployed: true }));
  const stale = JSON.stringify(buildSignedCard(PREVIOUS, { deployed: true }));
  const clock = fakeClock();
  const seq = sequence(n => (n <= 2 ? stale : fresh));
  const slowGet = async url => { await clock.sleep(15000); return seq.get(url); };
  const stats = {};
  const failures = await checkAgentCardDoor({ url: doorUrl, fetches: 10, gapMs: 1500, waitMs: 90000, get: slowGet, ...clock, ...opts, stats });
  assert.ok(failures.at(-1).startsWith("not converged"), `got: ${failures.at(-1)}`);
  assert.equal(stats.converged, false);
  assert.ok(seq.count() < 12, `stopped at the window, not after the streak: ${seq.count()}`);
});
