import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "./spawn.mjs";
import { configHome } from "./config.mjs";

const SERVICE = "room-machine";

function secretPath(home, account) {
  return join(home, "secrets", account);
}

// Write the 0600 file, then copy the same bytes to Keychain on stdin.
// The Keychain command's arguments name the account. They do not carry the
// secret. The daemon reads Keychain first and falls back to the file.
export async function saveSecret(account, value, home = configHome()) {
  const text = String(value);
  const dir = join(home, "secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = secretPath(home, account);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  await runCommand("security", [
    "add-generic-password", "-s", SERVICE, "-a", account, "-U",
  ], { input: text, timeoutMs: 5000 });
  return path;
}

export async function readSecret(account, home = configHome()) {
  const found = await runCommand("security", [
    "find-generic-password", "-s", SERVICE, "-a", account, "-w",
  ], { timeoutMs: 5000, maxBytes: 4096 });
  const fromKeychain = found.code === 0 ? found.stdout.toString("utf8").replace(/\n$/, "") : "";
  if (fromKeychain) return fromKeychain;
  const path = secretPath(home, account);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}
