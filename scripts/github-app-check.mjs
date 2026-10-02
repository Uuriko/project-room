// Confirms github-app/manifest.json matches the permissions and URLs the
// shared GitHub App core publishes. Does not call GitHub and does not print
// secret values. Missing credentials leave the integration off.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANIFEST_EVENTS,
  MANIFEST_PERMISSIONS,
  MANIFEST_SETUP_URL,
  MANIFEST_WEBHOOK_URL,
  githubAppCredentials,
} from "../server/github-app/index.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "github-app", "manifest.json"), "utf8"));
const problems = [];
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

if (!same(manifest.default_permissions, MANIFEST_PERMISSIONS)) problems.push("default_permissions do not match the shared core");
if (!same(manifest.default_events, [...MANIFEST_EVENTS])) problems.push("default_events do not match the shared core");
if (manifest.hook_attributes?.url !== MANIFEST_WEBHOOK_URL) problems.push("webhook URL does not match the shared core");
if (manifest.setup_url !== MANIFEST_SETUP_URL || manifest.redirect_url !== MANIFEST_SETUP_URL) problems.push("setup URL does not match the shared core");
if (manifest.request_oauth_on_install !== true) problems.push("request_oauth_on_install must be true");

if (problems.length) {
  for (const problem of problems) console.error(`github-app-check: ${problem}`);
  process.exit(1);
}

const configured = githubAppCredentials(process.env) !== null;
console.log(`github-app-check: manifest matches the shared core; credentials ${configured ? "are set" : "are not set, so the integration stays off"}`);
