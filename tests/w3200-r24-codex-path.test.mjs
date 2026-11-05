// W3200 R-24: the dedicated Codex host spawn env PATH must include
// /usr/local/bin (the Intel Homebrew prefix), as LocalRoomHost.swift:181
// already does — otherwise the host starts but its subprocesses cannot
// resolve Intel-Homebrew tools. Falsifier executed here: read the PATH the
// host actually spawns with (reported by the fake Codex child through the
// real openCodexStdio transport), stand a temp dir in for /usr/local/bin
// holding a tool found nowhere else, scrub PATH to exactly that spawn env
// (with the stand-in substituted), and require the tool to resolve and run.
// Fixture files are all written BEFORE the dynamic import of the module
// under test, so this file also runs in sandboxes that restrict writes
// from processes that loaded the credential-handling modules.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("host spawn PATH includes /usr/local/bin and a tool resolvable only there runs", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "w3200-r24-")));
  const cwd = join(root, "workspace"), codexHome = join(root, "codex-home");
  mkdirSync(cwd); mkdirSync(codexHome, { mode: 0o700 });
  const command = join(root, "fake-codex");
  writeFileSync(command, `#!${process.execPath}\nimport readline from 'node:readline';\nconst send=v=>process.stdout.write(JSON.stringify(v)+'\\n');\nconst lines=readline.createInterface({input:process.stdin});\nlines.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;if(m.method==='initialize'){send({id:m.id,result:{path:process.env.PATH}});return;}send({id:m.id,error:{code:-32601,message:'unknown'}});});\n`);
  chmodSync(command, 0o700);
  // Stand-in for /usr/local/bin (this machine's real /usr/local/bin is not
  // the Intel-Mac prefix under test), prepared before the import as well.
  const standIn = join(root, "intel-homebrew-bin");
  mkdirSync(standIn);
  const tool = join(standIn, "w3200-r24-probe");
  writeFileSync(tool, "#!/bin/sh\necho probe-ok\n");
  chmodSync(tool, 0o755);
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* cleanup best-effort */ } });

  const { openCodexStdio } = await import("../client/codex-stdio.mjs");
  const config = { command, cwd, codexHome, policy: { approvalPolicy: "never", sandbox: "read-only" }, requestTimeoutMs: 3000 };
  const rpc = openCodexStdio(config);
  const { path: spawnPath } = await rpc.request("initialize", {});
  await rpc.close();
  assert.ok(spawnPath.split(":").includes("/usr/local/bin"), `spawn PATH lacks /usr/local/bin: ${spawnPath}`);

  const scrubbed = spawnPath.split(":").map(seg => seg === "/usr/local/bin" ? standIn : seg).join(":");
  const run = spawnSync("w3200-r24-probe", [], { env: { PATH: scrubbed }, encoding: "utf8" });
  assert.equal(run.status, 0, run.error?.message ?? run.stderr);
  assert.match(run.stdout, /probe-ok/);
});
