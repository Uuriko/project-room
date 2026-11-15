#!/usr/bin/env node
// Print the GitHub App manifest for one Room instance.
//
//   node scripts/github-app-manifest.mjs https://room.example > manifest.json
//
// With no argument it prints the hosted manifest (github-app/manifest.json).
// Does not call GitHub and reads no credentials.
import { githubAppManifest } from "../server/github-app/index.mjs";

try {
  process.stdout.write(`${JSON.stringify(githubAppManifest(process.argv[2]), null, 2)}\n`);
} catch (error) {
  console.error(`github-app-manifest: ${error.message}`);
  process.exit(1);
}
