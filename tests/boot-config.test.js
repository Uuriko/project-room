// Fail-loud config boot gate (RC-2026-09-27-2732, UFO-steal slice 5).
//
// The boot gate (server/boot-config.mjs) must throw a member-facing error
// naming the missing item when critical config is absent in production, and
// the agent card must mark its unsigned state explicitly instead of silently
// dropping the signature fields (the a33d701f production incident: the card
// served unsigned with nothing on record).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateCriticalConfig } from "../server/boot-config.mjs";
import { agentCard, agentCardSignatureState, markUnsignedCard } from "../deploy/agent-discovery.mjs";
import { AGENT_CARD_UNSIGNED_REASON } from "../deploy/agent-card-signed.mjs";
import { signAgentCard } from "../scripts/sign-agent-card.mjs";
import { generateKeyPair } from "../server/agent-card-signing.mjs";

const signed = { signed: true, signedRevision: "rev", unsignedReason: null };
const unsignedSilent = { signed: false, signedRevision: null, unsignedReason: null };
const unsignedExplicit = { signed: false, signedRevision: null, unsignedReason: "explicit --allow-unsigned at build 2026-09-27 (dev build)" };

test("production + unsigned card with no opt-in record throws a member-facing error naming the fix", () => {
  assert.throws(
    () => validateCriticalConfig({ production: true, cardSignature: unsignedSilent }),
    error => {
      assert.match(error.message, /UNSIGNED agent card/i);
      assert.match(error.message, /ROOM_AGENT_CARD_SIGNING_KEY/);
      assert.match(error.message, /sign-agent-card/);
      return true;
    }
  );
});

test("production + unsigned card even with explicit opt-in still throws: production must be signed", () => {
  assert.throws(
    () => validateCriticalConfig({ production: true, cardSignature: unsignedExplicit }),
    error => {
      assert.match(error.message, /production must ship a SIGNED card/i);
      assert.match(error.message, /--allow-unsigned/);
      return true;
    }
  );
});

test("dev + unsigned card with no opt-in record warns loudly but boots", () => {
  const { warnings } = validateCriticalConfig({ production: false, cardSignature: unsignedSilent });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /UNSIGNED/i);
  assert.match(warnings[0], /no explicit opt-in/i);
  assert.match(warnings[0], /ROOM_AGENT_CARD_SIGNING_KEY|--allow-unsigned/);
});

test("dev + explicit unsigned opt-in warns but permits the degraded mode", () => {
  const { warnings } = validateCriticalConfig({ production: false, cardSignature: unsignedExplicit });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /UNSIGNED by explicit build opt-in/i);
  assert.match(warnings[0], /signed:false/);
});

test("signed card passes clean with no warnings", () => {
  const { warnings } = validateCriticalConfig({ production: true, cardSignature: signed });
  assert.deepEqual(warnings, []);
  const dev = validateCriticalConfig({ production: false, cardSignature: signed });
  assert.deepEqual(dev.warnings, []);
});

test("served card marks the unsigned state explicitly (signed:false), never silently", () => {
  // The checked-in build module is the unsigned default with no opt-in
  // recorded, so agentCard() must mark it.
  assert.equal(AGENT_CARD_UNSIGNED_REASON, null);
  const card = agentCard();
  assert.equal(card.signed, false);
  assert.equal("unsignedReason" in card, false, "no reason to record when none was given");
  assert.equal(card.cardSignature, undefined, "unsigned cards still carry no signature fields");
});

test("markUnsignedCard records the explicit reason on the card", () => {
  const card = markUnsignedCard({ name: "fixture" }, "explicit --allow-unsigned at build (dev)");
  assert.equal(card.signed, false);
  assert.equal(card.unsignedReason, "explicit --allow-unsigned at build (dev)");
  const noReason = markUnsignedCard({ name: "fixture" }, null);
  assert.equal(noReason.signed, false);
  assert.equal("unsignedReason" in noReason, false);
});

test("sign-agent-card --allow-unsigned records the opt-in in the module; signed builds clear it", async t => {
  const directory = mkdtempSync(join(tmpdir(), "card-optin-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "signed.mjs"), key = generateKeyPair();
  const card = { name: "Fixture", deployed: { revision: "optin-revision" } };
  // Explicit opt-in: the reason names the flag and is importable.
  signAgentCard({ privateKey: null, card, outputPath, allowUnsigned: true });
  const unsigned = await import(`${pathToFileURL(outputPath).href}?optin=${Date.now()}`);
  assert.match(unsigned.AGENT_CARD_UNSIGNED_REASON, /--allow-unsigned/);
  // Signed build: the opt-in record is explicitly cleared.
  signAgentCard({ privateKey: key.privateKey, publicKey: key.publicKey, agentId: "project-room", card, outputPath });
  const signedModule = await import(`${pathToFileURL(outputPath).href}?signed=${Date.now()}`);
  assert.equal(signedModule.AGENT_CARD_UNSIGNED_REASON, null);
  assert.ok(signedModule.AGENT_CARD_SIGNATURE);
});

test("agentCardSignatureState mirrors the serve path's revision gate", () => {
  const state = agentCardSignatureState();
  assert.equal(typeof state.signed, "boolean");
  // In this checkout the build module is the unsigned default.
  assert.equal(AGENT_CARD_UNSIGNED_REASON, null);
  assert.equal(state.signed, false);
  assert.equal(state.unsignedReason, null);
});

test("QA200-REG-14: bare validateCriticalConfig() (dev default path) warns loudly, never throws", () => {
  // Regression guard for the `??` default: an absent cardSignature must
  // degrade to the unsigned dev warning, never a fail-open clean pass.
  const { warnings } = validateCriticalConfig();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /UNSIGNED/i);
  assert.match(warnings[0], /ROOM_AGENT_CARD_SIGNING_KEY|--allow-unsigned/);
});

test("QA200-REG-14: production with no cardSignature refuses boot (fail-loud default)", () => {
  // Guards the defaulting logic against a fail-open regression where the
  // absent card state is treated as signed.
  assert.throws(
    () => validateCriticalConfig({ production: true }),
    error => {
      assert.match(error.message, /Refusing to boot/);
      assert.match(error.message, /UNSIGNED/i);
      assert.match(error.message, /ROOM_AGENT_CARD_SIGNING_KEY/);
      return true;
    }
  );
  assert.throws(
    () => validateCriticalConfig({ production: true, cardSignature: { signed: false } }),
    /Refusing to boot/
  );
});
