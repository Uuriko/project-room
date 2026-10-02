import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME;
const args = process.argv.slice(2);
appendFileSync(join(home, "argv-log"), `security ${args.map(arg => JSON.stringify(arg)).join(" ")}\n`);
appendFileSync(join(home, "env-log"), `${Object.entries(process.env).map(([key, value]) => `${key}=${value}`).join("\n")}\n---\n`);
const accountFlag = args.indexOf("-a");
const account = accountFlag === -1 ? "default" : args[accountFlag + 1];
const dir = join(home, "security-store");
mkdirSync(dir, { recursive: true });
const chunks = [];
process.stdin.on("data", chunk => chunks.push(chunk));
process.stdin.on("end", () => {
  const stdin = Buffer.concat(chunks);
  if (args[0] === "add-generic-password") {
    writeFileSync(join(dir, account), stdin);
    writeFileSync(join(home, "security-stdin"), stdin);
  }
  if (args[0] === "find-generic-password" && existsSync(join(dir, account))) {
    const stored = readFileSync(join(dir, account));
    process.stdout.write(stored);
    if (!stored.toString("utf8").endsWith("\n")) process.stdout.write("\n");
  }
  process.exit(0);
});
process.stdin.resume();
