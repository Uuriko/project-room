import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DM_CONSENT_STATUSES,
  DM_CONSENT_DECISIONS as SERVER_DECISIONS,
  DM_CONSENT_REFUSAL_CODES as SERVER_REFUSAL_CODES,
  dmConsentSchema,
} from "../server/dm-consents.mjs";
import * as client from "../src/dm-consents.js";
import { hasDmConsentVocabMarkers, syncDmConsentVocab } from "../scripts/sync-dm-consent-vocab.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientText = readFileSync(join(root, "src", "dm-consents.js"), "utf8");
const serverText = readFileSync(join(root, "server", "dm-consents.mjs"), "utf8");

test("dm-consent parity: client decisions match the server module exactly", () => {
  assert.deepEqual([...client.DM_CONSENT_DECISIONS], [...SERVER_DECISIONS]);
});

test("dm-consent parity: client refusal codes match the server module exactly", () => {
  assert.deepEqual([...client.DM_CONSENT_REFUSAL_CODES], [...SERVER_REFUSAL_CODES]);
});

test("dm-consent parity: the stamped client block regenerates byte-identically from the server module", () => {
  assert.equal(hasDmConsentVocabMarkers(clientText), true);
  assert.equal(syncDmConsentVocab(clientText), clientText);
});

test("dm-consent parity: the server refusal codes are exactly the 403 codes the server gate emits", () => {
  const emitted = new Set([...serverText.matchAll(/fail\(403, "([^"]+)"/g)].map(m => m[1]));
  assert.deepEqual(emitted, new Set(SERVER_REFUSAL_CODES));
});

test("dm-consent parity: the server statuses match the dm_consents schema CHECK constraint", () => {
  const check = /CHECK\(status IN \(([^)]+)\)\)/.exec(dmConsentSchema);
  assert.ok(check, "dmConsentSchema carries a status CHECK constraint");
  const schemaStatuses = [...check[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(schemaStatuses, [...DM_CONSENT_STATUSES]);
});

test("dm-consent parity: the dead client DM_CONSENT_STATUSES literal stays deleted", () => {
  assert.equal("DM_CONSENT_STATUSES" in client, false);
  assert.equal(/export const DM_CONSENT_STATUSES/.test(clientText), false);
});
