#!/usr/bin/env node
import { nativeConnect, nativeLogin } from "../client/native-agent-setup.mjs";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export async function nativeSetupMain(input = process.stdin, emit = value => process.stdout.write(JSON.stringify(value) + "\n")) {
  let text = "";
  for await (const chunk of input) {
    text += chunk;
    if (Buffer.byteLength(text) > 16384) throw new Error("Setup input too large");
  }
  const request = JSON.parse(text);
  if (request.action === "connect") { emit(await nativeConnect(request)); return; }
  if (request.action !== "login") throw new Error("Unsupported setup action");
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
  try { emit(await nativeLogin(request.config, { emit, signal: controller.signal })); }
  finally { process.off("SIGTERM", cancel); process.off("SIGINT", cancel); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  nativeSetupMain().catch(() => {
    // Exceptions can include paths, room text or provider diagnostics; UI gets
    // a stable failure status instead of arbitrary subprocess output.
    process.stdout.write(JSON.stringify({ status: "setup_failed" }) + "\n"); process.exitCode = 1;
  });
}
