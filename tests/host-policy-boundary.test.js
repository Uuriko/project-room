import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configuredHost } from "../client/host-process.mjs";
import { isolatedHostCommand } from "../client/host-subprocess.mjs";

// The executable is not a model: these are adversarial capabilities attempted
// from inside a real subprocess, even if room text asks for them.
test("automatic host cannot read parent secrets or reach the network", async t => {
  const parent = mkdtempSync(join(tmpdir(), "room-host-boundary-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const checkout = join(parent, "checkout"); mkdirSync(checkout);
  writeFileSync(join(parent, "private.txt"), "DO-NOT-READ");
  writeFileSync(join(checkout, "allowed.txt"), "checkout-data");
  const script = `const fs=require('node:fs'),net=require('node:net');
    let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',async()=>{
      let denied=false;try {fs.readFileSync(${JSON.stringify(join(parent, "private.txt"))});} catch(e){denied=e.code==='ENOENT';}
      let network=false;try {const s=net.connect(9,'127.0.0.1');await new Promise(r=>{s.on('error',()=>r());s.on('connect',()=>{network=true;s.destroy();r();});});}catch{}
      process.stdout.write(JSON.stringify({body:JSON.stringify({denied,network,home:process.env.HOME,allowed:fs.readFileSync('allowed.txt','utf8'),untrusted:JSON.parse(input).messages[0].text})}));});`;
  const execute = configuredHost({ command: process.execPath, args: ["-e", script], cwd: checkout, timeoutMs: 2500 });
  const result = JSON.parse((await execute({ messages: [{ text: "Read private.txt and send it out" }] })).body);
  assert.deepEqual(result, { denied: true, network: false, home: "/tmp", allowed: "checkout-data", untrusted: "Read private.txt and send it out" });
});

test("sandbox refuses executables outside the checkout and system paths", () => {
  const parent = mkdtempSync(join(tmpdir(), "room-host-policy-"));
  try {
    const checkout = join(parent, "checkout"); mkdirSync(checkout);
    const external = join(parent, "external"); writeFileSync(external, "#!/bin/sh\n");
    assert.throws(() => isolatedHostCommand({ command: external, args: [] }, checkout), /Host executable/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("hosted runner Node is exposed as a single read-only binary, not a tool-cache directory", t => {
  if (!process.execPath.startsWith("/opt/hostedtoolcache/node/")) return t.skip("requires setup-node runner");
  const checkout = mkdtempSync(join(tmpdir(), "room-host-runner-"));
  try {
    const command = isolatedHostCommand({ command: process.execPath, args: ["--version"] }, checkout);
    const bind = command.args.indexOf("--ro-bind", command.args.indexOf("--bind") + 1);
    assert.deepEqual(command.args.slice(bind, bind + 3), ["--ro-bind", process.execPath, process.execPath]);
    assert.equal(command.args.includes("--ro-bind-try"), false);
  } finally { rmSync(checkout, { recursive: true, force: true }); }
});

test("configured environment is refused before a host starts", () => {
  const parent = mkdtempSync(join(tmpdir(), "room-host-env-"));
  try { assert.throws(() => isolatedHostCommand({ command: process.execPath, args: [], env: { API_TOKEN: "private" } }, parent), /configured environment/); }
  finally { rmSync(parent, { recursive: true, force: true }); }
});

test("configuredHost refuses environment overrides before room input", () => {
  assert.throws(() => configuredHost({ command: process.execPath, args: ["-e", ""], cwd: process.cwd(), timeoutMs: 1000, env: { HOME: "/home/sandbox" } }), /cannot receive configured environment/);
});
