import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const home = process.env.HOME;
const args = process.argv.slice(2);
appendFileSync(join(home, "argv-log"), `lume ${args.map(arg => JSON.stringify(arg)).join(" ")}\n`);
appendFileSync(join(home, "env-log"), `${Object.entries(process.env).map(([key, value]) => `${key}=${value}`).join("\n")}\n---\n`);
const command = args[0];
if (command === "--version" || command === "version") {
  process.stdout.write("lume 0.6.0-fake\n");
  process.exit(0);
}
if (command === "screenshot") {
  const out = args[args.indexOf("--out") + 1];
  writeFileSync(out, "frame-bytes");
  process.exit(0);
}
if (command === "ssh") {
  const remote = args.slice(args.indexOf("--") + 1);
  if (remote[0] === "cua-driver") {
    const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "cua-driver.mjs"), ...remote.slice(1)], { stdio: "inherit" });
    child.on("exit", code => process.exit(code ?? 1));
  } else {
    const text = remote.join(" ");
    if (text.includes("sleep-me")) {
      setTimeout(() => process.exit(0), 30_000);
    } else if (text.includes("big-output")) {
      process.stdout.write("x".repeat(200_000), () => process.exit(0));
    } else {
      process.stdin.on("data", () => {});
      process.stdin.on("end", () => process.exit(0));
      process.stdin.resume();
    }
  }
} else {
  process.exit(0);
}
