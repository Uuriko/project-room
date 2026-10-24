// QA regression-spine — shared probe helpers.
//
// Every probe prints exactly one verdict line as its LAST stdout line:
//   R1-VERDICT <FIXED|STILL|NOTFILED> :: <one-line reason>
// FIXED    — the original repro now refuses / heals / is absent, as designed.
// STILL    — the defect still reproduces against the target tree.
// NOTFILED — the repro could not be executed as filed in this environment;
//            the reason says why (never a silent skip).
//
// Probes run against the tree named by R1_ROOT (the runner sets it; when the
// pack lives in the repo, the default is the repo root). Probes must never
// write into R1_ROOT except mutation probes, which work on a private copy.

import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

export const ROOT = resolve(process.env.R1_ROOT ?? join(import.meta.dirname, "..", "..", ".."));
export const TMP = process.env.R1_TMP ?? process.env.TMPDIR ?? "/tmp";

let printed = false;
export function verdict(cls, reason) {
  if (printed) return;
  printed = true;
  const clean = String(reason).replace(/\s+/g, " ").slice(0, 400);
  console.log(`R1-VERDICT ${cls} :: ${clean}`);
}
export const fixed = (r) => verdict("FIXED", r);
export const still = (r) => verdict("STILL", r);
export const notfiled = (r) => verdict("NOTFILED", r);

// Any uncaught probe error is a NOTFILED with the error as the reason —
// a crashed probe is evidence about the probe, not about the product.
process.on("uncaughtException", (e) => { notfiled(`probe error: ${e.message}`); process.exit(0); });
process.on("unhandledRejection", (e) => { notfiled(`probe error: ${e?.message ?? e}`); process.exit(0); });

export const srcPath = (rel) => join(ROOT, rel);
export function readSrc(rel) {
  const p = srcPath(rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
export function srcHas(rel, re) {
  const s = readSrc(rel);
  return s !== null && re.test(s);
}
export function srcLacks(rel, re) {
  const s = readSrc(rel);
  return s !== null && !re.test(s);
}
// Structural verdict helper: defect mechanism present in source -> STILL;
// mechanism replaced by the named fix shape -> FIXED; file gone -> FIXED
// only when the caller asserts the surface was removed by a named PR.
export function srcVerdict(rel, defectRe, fixRe, labels) {
  const s = readSrc(rel);
  if (s === null) return notfiled(`source file ${rel} not found in target tree`);
  if (fixRe && fixRe.test(s)) return fixed(`${rel}: ${labels.fix}`);
  if (defectRe.test(s)) return still(`${rel}: ${labels.defect}`);
  return notfiled(`${rel}: neither the filed defect shape nor the fix shape matched — source drifted, re-derive the probe`);
}

export async function dynImport(rel) {
  return import(pathToFileURL(srcPath(rel)).href);
}

// Boot the repo's acceptance fixture + HTTP server on an ephemeral port
// (the HUNT-DIFFERENTIAL harness shape).
export async function bootServer() {
  const { createAcceptanceFixture } = await dynImport("scripts/acceptance-fixture.mjs");
  const { createRoomServer } = await dynImport("server/http.mjs");
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    try { server.closeStreams?.(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); } catch {}
    try { f.store.close(); } catch {}
  };
  return { f, server, origin, close };
}

export async function rest(origin, secret, method, path, body, headers = {}) {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { _raw: text.slice(0, 300) }; }
  return { status: res.status, body: parsed };
}
export const post = (o, s, p, b, h) => rest(o, s, "POST", p, b, h);
export const get = (o, s, p, h) => rest(o, s, "GET", p, undefined, h);

let mcpId = 0;
export async function mcp(origin, secret, name, args = {}, profile) {
  const url = profile ? `${origin}/mcp?profile=${profile}` : `${origin}/mcp`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++mcpId, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  let rpc = null;
  try { rpc = JSON.parse(text); } catch { rpc = { _raw: text.slice(0, 300) }; }
  let value = null, isError = false;
  if (rpc?.result) {
    isError = rpc.result.isError === true;
    const content = rpc.result.content?.[0]?.text;
    if (typeof content === "string") { try { value = JSON.parse(content); } catch { value = content; } }
  } else if (rpc?.error) {
    isError = true;
    value = rpc.error;
  }
  return { status: res.status, isError, value, rpc };
}

// Create a room member with permissions on a booted fixture (the
// HUNT-DIFFERENTIAL harness's mkMember, verbatim semantics).
export function mkMember(f, name, roomId, permissions) {
  const ident = f.store.identities.create(name);
  f.store.identities.link(f.keys.owner, roomId, { identityId: ident.identityId, permissions });
  const auth = f.store.authenticate(ident.secret, roomId);
  return { identityId: ident.identityId, secret: ident.secret, memberId: auth.member.id };
}
export const codeOf = (r) => r?.body?.error?.code ?? r?.value?.code ?? r?.value?.reason ?? null;

// Materialise a vendored original repro (probes/vendor/<name>) with the
// tree-root token substituted, and run it unmodified otherwise.
export async function vendorRun(name, { timeoutMs = 240000, env = {} } = {}) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const src = readFileSync(join(HERE, "probes", "vendor", name), "utf8");
  const file = join(TMP, `vendor-${name.replace(/\.txt$/, "")}`);
  mkdirSync(TMP, { recursive: true });
  writeFileSync(file, src.split("__R1ROOT__").join(ROOT));
  return runNode([file], { cwd: TMP, timeoutMs, env });
}

// Run a repo test file (or any node script) inside the target tree.
export function runNode(args, { cwd = ROOT, timeoutMs = 240000, env = {} } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, TMPDIR: TMP, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; if (out.length > 2_000_000) out = out.slice(-2_000_000); });
    child.stderr.on("data", (d) => { err += d; if (err.length > 500_000) err = err.slice(-500_000); });
    child.on("close", (code) => { clearTimeout(timer); resolvePromise({ code, out, err }); });
    child.on("error", (e) => { clearTimeout(timer); resolvePromise({ code: -1, out, err: String(e) }); });
  });
}

// In-memory escrow world with a controllable clock (the HUNT-ECONOMICS
// probe pattern): a minimal store over node:sqlite + BountyEscrow.
export async function escrowWorld(startMs = 1_786_000_000_000) {
  const { DatabaseSync } = await import("node:sqlite");
  const { BountyEscrow } = await dynImport("server/bounty-escrow.mjs");
  const keeperMod = await dynImport("server/bounty-epoch-keeper.mjs");
  let nowMs = startMs;
  const db = new DatabaseSync(":memory:");
  const transaction = (fn) => {
    db.exec("SAVEPOINT t");
    try { const out = fn(); db.exec("RELEASE t"); return out; }
    catch (e) { db.exec("ROLLBACK TO t"); db.exec("RELEASE t"); throw e; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  return {
    db, store, escrow,
    progressEscrowEpochs: keeperMod.progressEscrowEpochs,
    now: () => nowMs,
    advance: (ms) => { nowMs += ms; },
    iso: (deltaMs) => new Date(nowMs + deltaMs).toISOString(),
    DAY: 24 * 3600 * 1000,
  };
}
