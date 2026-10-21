// Regenerate the DM consent vocabulary block in src/dm-consents.js from
// server/dm-consents.mjs (single source of truth).
//
// The browser module carries marker comments; everything between the
// begin/end marker pair is replaced with the declarations generated from
// the server constants, preserving the surrounding lines. Values stay
// byte-identical when the vocabulary is unchanged, so regeneration is a
// no-op diff unless a server constant actually moved.
//
// Run:   node scripts/sync-dm-consent-vocab.mjs
// Check: node scripts/sync-dm-consent-vocab.mjs --check   (CI gate)
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DM_CONSENT_DECISIONS, DM_CONSENT_REFUSAL_CODES } from "../server/dm-consents.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_PATH = join(root, "src", "dm-consents.js");

const BEGIN = "// dm-consent-vocab:begin";
const END = "// dm-consent-vocab:end";

const renderArray = values => `[${values.map(value => JSON.stringify(value)).join(", ")}]`;

export function dmConsentVocabBlock() {
  return [
    `export const DM_CONSENT_DECISIONS = Object.freeze(${renderArray(DM_CONSENT_DECISIONS)});`,
    `export const DM_CONSENT_REFUSAL_CODES = Object.freeze(${renderArray(DM_CONSENT_REFUSAL_CODES)});`,
  ].join("\n");
}

export function hasDmConsentVocabMarkers(clientText) {
  return clientText.includes(BEGIN) && clientText.includes(END);
}

export function syncDmConsentVocab(clientText) {
  const b = clientText.indexOf(BEGIN);
  const e = clientText.indexOf(END, b);
  if (b === -1 || e === -1) return clientText;
  const lineStart = clientText.lastIndexOf("\n", b) + 1;
  const lineEnd = clientText.indexOf("\n", e + END.length);
  const indent = clientText.slice(lineStart, b).match(/^[ \t]*/)[0];
  const block = dmConsentVocabBlock().split("\n").map(line => indent + line).join("\n");
  return (
    clientText.slice(0, lineStart) +
    `${indent}${BEGIN}\n${block}\n${indent}${END}` +
    clientText.slice(lineEnd)
  );
}

const isMainModule =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const check = process.argv.includes("--check");
  const before = readFileSync(CLIENT_PATH, "utf8");
  if (!hasDmConsentVocabMarkers(before)) {
    console.error("sync-dm-consent-vocab: vocab markers missing from src/dm-consents.js");
    process.exit(1);
  }
  const after = syncDmConsentVocab(before);
  if (after !== before) {
    if (check) {
      console.error(
        "sync-dm-consent-vocab: src/dm-consents.js vocabulary is out of sync with server/dm-consents.mjs — run: node scripts/sync-dm-consent-vocab.mjs",
      );
      process.exit(1);
    }
    writeFileSync(CLIENT_PATH, after);
    console.log("sync-dm-consent-vocab: regenerated vocabulary block in src/dm-consents.js");
  } else {
    console.log("sync-dm-consent-vocab: src/dm-consents.js already in sync");
  }
}
