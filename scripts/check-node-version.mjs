// Fail fast when the self-host start path runs on a Node older than the
// engines floor in package.json. npm only warns on engines by default, so
// without this check an old Node fails later with confusing module or
// node:sqlite errors. Wired as the `prestart` script: `npm start` runs it
// first and stops here with the remedy.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const floor = />=\s*(\d+)\.(\d+)\.(\d+)/.exec(pkg.engines?.node ?? "");
if (!floor) {
  console.error(`check-node-version: could not parse a >=x.y.z floor from package.json engines.node (${pkg.engines?.node}); refusing to guess.`);
  process.exit(1);
}
const required = floor.slice(1).map(Number);
const current = process.versions.node.split(".").map(Number);
let below = false;
for (let i = 0; i < required.length; i++) {
  if (current[i] === required[i]) continue;
  below = (current[i] ?? 0) < required[i];
  break;
}
if (below) {
  console.error(
    `Project Room needs Node ${required.join(".")} or newer (package.json engines); this is Node ${process.versions.node}.\n` +
    `Remedy: install a current Node 24 LTS from https://nodejs.org or via your version manager (e.g. \`nvm install 24\`), then re-run \`npm ci\` and \`npm start\`.`,
  );
  process.exit(1);
}
