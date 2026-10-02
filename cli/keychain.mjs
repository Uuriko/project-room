// OS keychain for the identity secret. Absent or failing tools leave the
// secret in the private connection file. This module never prints the secret.
import { spawn } from "node:child_process";
import { commandOnPath } from "./which.mjs";

const SERVICE = "project-room";

function run(command, args, { input, env, timeoutMs = 3000 }) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, { env, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve({ status: null, out: "" });
      return;
    }
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ status: null, out });
    }, timeoutMs);
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve({ status: null, out }); });
    child.on("close", status => { clearTimeout(timer); resolve({ status, out }); });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

function tool(env) {
  if (env.PROJECT_ROOM_KEYCHAIN === "0") return null;
  if (process.platform === "darwin" && commandOnPath("security", env)) return "security";
  if (process.platform === "linux" && commandOnPath("secret-tool", env)) return "secret-tool";
  return null;
}

export async function keychainStore(account, secret, env = process.env) {
  const which = tool(env);
  if (!which) return false;
  if (which === "security") {
    const result = await run("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", secret], { env });
    return result.status === 0;
  }
  const result = await run("secret-tool", ["store", "--label", "Project Room", "service", SERVICE, "account", account], { input: secret, env });
  return result.status === 0;
}

export async function keychainLookup(account, env = process.env) {
  const which = tool(env);
  if (!which) return null;
  if (which === "security") {
    const result = await run("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], { env });
    if (result.status !== 0) return null;
    const value = result.out.replace(/\n$/, "");
    return value.length > 0 ? value : null;
  }
  const result = await run("secret-tool", ["lookup", "service", SERVICE, "account", account], { env });
  if (result.status !== 0) return null;
  const value = result.out.replace(/\n$/, "");
  return value.length > 0 ? value : null;
}
