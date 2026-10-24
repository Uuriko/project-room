// Generates server/og-assets-embedded.mjs from og/: the OG renderer's
// asset bytes (glyph atlas + base card) embedded as base64. The worker
// bundle has no readable file system for paths built at runtime, so
// server/og-render.mjs falls back to this copy when its disk reads fail
// (the same pattern as server/legal-documents.mjs for the legal pages).
// Re-run with `npm run build:og-assets` after `npm run build:og-atlas`;
// tests/og-assets-embedded.test.js fails if the copies drift.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["atlas.json", "atlas-inter-24.png", "atlas-inter-32.png", "atlas-inter-48.png", "base-receipt.png"];

const entries = FILES.map(name => {
  const base64 = readFileSync(join(root, "og", name)).toString("base64");
  return `  ${JSON.stringify(name)}: ${JSON.stringify(base64)},`;
}).join("\n");

const out = `// Generated from og/ by scripts/build-og-assets.mjs — do not edit by hand.
// The OG renderer's assets embedded as base64: the worker-bundle fallback
// for server/og-render.mjs when its disk reads are unavailable.
export const EMBEDDED_OG_ASSETS = {
${entries}
};
`;

writeFileSync(join(root, "server", "og-assets-embedded.mjs"), out);
console.log(`Wrote server/og-assets-embedded.mjs from ${FILES.length} og/ assets.`);
