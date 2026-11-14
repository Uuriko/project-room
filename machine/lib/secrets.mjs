import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "./spawn.mjs";
import { configHome } from "./config.mjs";

const SERVICE = "room-machine";

function secretPath(home, account) {
  return join(home, "secrets", account);
}

// security(1) in -i mode reads one command per line from stdin. Quoting the
// values and sending the line on stdin keeps the secret out of argv, which any
// local user can read with ps. (add-generic-password without -w stores an
// empty password; it never reads one from stdin.)
function securityQuote(value) {
  return `"${String(value).replace(/["\\]/g, "\\$&")}"`;
}

async function keychainRead(account) {
  const found = await runCommand("security", [
    "find-generic-password", "-s", SERVICE, "-a", account, "-w",
  ], { timeoutMs: 5000, maxBytes: 4096 });
  return found.code === 0 ? found.stdout.toString("utf8").replace(/\n$/, "") : "";
}

// Write the 0600 file, then copy the same bytes to Keychain over stdin and
// read them back. The daemon reads Keychain first and falls back to the file.
export async function saveSecret(account, value, home = configHome()) {
  const text = String(value);
  const dir = join(home, "secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = secretPath(home, account);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  const drop = () => runCommand("security", ["delete-generic-password", "-s", SERVICE, "-a", account], { timeoutMs: 5000 });
  // One command per line: a value with a line break cannot go through -i.
  // Drop any older entry so it cannot shadow the file.
  if (/[\r\n]/.test(text) || /[\r\n]/.test(account)) { await drop(); return path; }
  const line = ["add-generic-password", "-U", "-s", securityQuote(SERVICE), "-a", securityQuote(account), "-w", securityQuote(text)].join(" ");
  await runCommand("security", ["-i"], { input: line + "\n", timeoutMs: 5000 });
  // -i can exit 0 after a failed command, and a stale entry would shadow the
  // file, so confirm the stored value and drop a mismatch.
  if (await keychainRead(account) !== text) await drop();
  return path;
}

export async function readSecret(account, home = configHome()) {
  const fromKeychain = await keychainRead(account);
  if (fromKeychain) return fromKeychain;
  const path = secretPath(home, account);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}
