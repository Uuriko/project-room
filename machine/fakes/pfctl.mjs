import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
appendFileSync(join(process.env.HOME, "argv-log"), `pfctl ${args.map(arg => JSON.stringify(arg)).join(" ")}\n`);
// Test hook: a $HOME/pfctl-fail-f marker file simulates a failed main-ruleset
// reload (pfctl -f) so the wirePfAnchor rollback path can be exercised
// without a real pf.
if (args[0] === "-f" && existsSync(join(process.env.HOME, "pfctl-fail-f"))) process.exit(1);
if (args[0] === "-s" && args[1] === "info") process.stdout.write("Status: Enabled\n");
if (args[0] === "-s" && args[1] === "Anchors") process.stdout.write("room.machine\n");
process.exit(0);
