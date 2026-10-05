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
const buildSignedCard = () => {
  const card = {
    name: "Test Room",
    description: "consistency fixture",
    url: null,
    capabilities: { streaming: false },
    skills: [],
    version: "1",
  };
  const signature = signCard({ agentId: AGENT_ID, card, privateKey: keyPair.privateKey });
  const withEnvelope = {
    ...card,
    keyId: KEY_ID,
    signatureAgentId: AGENT_ID,
    publicKey: keyPair.publicKey,
    cardSignature: signature,
    signedRevision: REVISION,
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

test("checkAgentCardDoor fails when the fetch sequence flaps signed/unsigned (#1524)", async () => {
  const signed = JSON.stringify(buildSignedCard());
  let n = 0;
  const get = async () => {
    n += 1;
    // 1 signed fetch in 15, like the QA-b production observation.
    const body = n === 7 ? signed : JSON.stringify({ signed: false, name: "x" });
    return { status: 200, json: JSON.parse(body), ms: 1 };
  };
  const failures = await checkAgentCardDoor({
    url: "https://example.test/.well-known/agent-card.json",
    fetches: 15, gapMs: 0, get, ...opts,
  });
  assert.ok(failures.length > 0, "expected the flapping sequence to fail");
  // Every failure names its fetch; exactly the 14 unsigned fetches fail —
  // the single signed fetch (#7) passes.
  const failedFetches = new Set(
    failures.map(f => Number(/^fetch #(\d+):/.exec(f)?.[1])).filter(Number.isInteger),
  );
  assert.deepEqual([...failedFetches].sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15]);
});
