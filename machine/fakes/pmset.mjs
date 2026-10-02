import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME;
const args = process.argv.slice(2);
const statePath = join(home, "pmset.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { disablesleep: "0", autorestart: "0" };
appendFileSync(join(home, "argv-log"), `pmset ${args.map(arg => JSON.stringify(arg)).join(" ")}\n`);
if (args[0] === "-g" && args[1] === "batt") {
  process.stdout.write("Now drawing from 'AC Power'\n");
  process.exit(0);
}
if (args[0] === "-g") {
  process.stdout.write(`disablesleep ${state.disablesleep}\nautorestart ${state.autorestart}\n`);
  process.exit(0);
}
if (args[0] === "-a" && args[2]) {
  state[args[1]] = args[2];
  writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
}
process.exit(0);
