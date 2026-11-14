import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Models the parts of macOS security(1) the machine uses. Like the real tool,
// add-generic-password stores the -w value and stores an empty password when
// -w is absent: it does not read the password from stdin. `security -i`
// reads one command per line from stdin, with double-quoted arguments.
const home = process.env.HOME;
const args = process.argv.slice(2);
appendFileSync(join(home, "argv-log"), `security ${args.map(arg => JSON.stringify(arg)).join(" ")}\n`);
appendFileSync(join(home, "env-log"), `${Object.entries(process.env).map(([key, value]) => `${key}=${value}`).join("\n")}\n---\n`);
const dir = join(home, "security-store");
mkdirSync(dir, { recursive: true });

function tokenize(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === " ") { i++; continue; }
    let token = "";
    if (line[i] === "\"") {
      i++;
      while (i < line.length && line[i] !== "\"") {
        if (line[i] === "\\" && i + 1 < line.length) i++;
        token += line[i++];
      }
      i++;
    } else {
      while (i < line.length && line[i] !== " ") token += line[i++];
    }
    out.push(token);
  }
  return out;
}

function flag(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 ? null : argv[at + 1] ?? null;
}

function execute(argv) {
  const account = flag(argv, "-a") ?? "default";
  if (argv[0] === "add-generic-password") {
    writeFileSync(join(dir, account), flag(argv, "-w") ?? "");
    return 0;
  }
  if (argv[0] === "delete-generic-password") {
    if (!existsSync(join(dir, account))) return 44;
    rmSync(join(dir, account));
    return 0;
  }
  if (argv[0] === "find-generic-password") {
    if (!existsSync(join(dir, account))) return 44;
    if (argv.includes("-w")) process.stdout.write(readFileSync(join(dir, account), "utf8") + "\n");
    return 0;
  }
  return 1;
}

const chunks = [];
process.stdin.on("data", chunk => chunks.push(chunk));
process.stdin.on("end", () => {
  const stdin = Buffer.concat(chunks);
  writeFileSync(join(home, "security-stdin"), stdin, { flag: "a" });
  if (args[0] === "-i") {
    for (const line of stdin.toString("utf8").split("\n")) if (line.trim()) execute(tokenize(line));
    process.exit(0);
  }
  process.exit(execute(args));
});
process.stdin.resume();
