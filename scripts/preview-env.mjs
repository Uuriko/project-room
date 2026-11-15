#!/usr/bin/env node
// Per-PR preview Workers (alchemy.run-style previews, wrangler only).
//
//   node scripts/preview-env.mjs config <pr>   writes cloudflare/wrangler.preview.jsonc
//   node scripts/preview-env.mjs parity <origin> [out.json]
//   node scripts/preview-env.mjs comment <pr> <origin> <smoke.json> <parity.json>
//
// config copies env.staging (no routes, no crons, workers.dev only) into
// env.preview with name room-pr-<n>. Durable Object storage is per Worker
// script, so a preview gets its own ROOM / ROOM_SHARD namespaces and never sees
// staging or production data. Production routes and vars are never copied.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
export const WORKERS_SUBDOMAIN = "getdasha.workers.dev";
export const previewName = pr => {
  if (!/^[1-9][0-9]{0,6}$/.test(String(pr))) throw new Error("PR number required");
  return `room-pr-${pr}`;
};
export const previewOrigin = pr => `https://${previewName(pr)}.${WORKERS_SUBDOMAIN}`;
const stripJsonc = text => text.replace(/^\s*\/\/.*$/gm, "");

export function previewConfig(config, pr) {
  const staging = config.env?.staging;
  if (!staging) throw new Error("wrangler.jsonc has no env.staging to copy");
  const name = previewName(pr);
  const preview = { ...structuredClone(staging), name, workers_dev: true, preview_urls: false, routes: [],
    triggers: { crons: [] },
    vars: { ...staging.vars, ROOM_ORIGIN: previewOrigin(pr), ROOM_DEPLOYMENT: "staging", ROOM_SERVICE_MODE: "cloudflare-staging" } };
  // Top-level routes/crons are production's; blank them too so no form of
  // this file can bind a production route.
  return { ...config, name, routes: [], workers_dev: true, triggers: { crons: [] }, vars: preview.vars, env: { preview } };
}

// Bootstraps a throwaway room on the preview with the open self-serve path
// (mint identity, create room) and runs the #5882 probes when they exist.
// The identity secret is masked in Actions logs and never written out.
export async function previewParity(origin, { probesPath = join(repo, "tests/linear-parity/parity-probes.mjs") } = {}) {
  if (!existsSync(probesPath)) return { status: "skipped", reason: "tests/linear-parity (#5882) is not on this branch" };
  const H = { "Content-Type": "application/json", "User-Agent": "project-room-agent preview-parity" };
  const minted = await fetch(origin + "/api/agent-identities", { method: "POST", headers: H, body: JSON.stringify({ displayName: "PreviewParity" }) });
  const id = await minted.json().catch(() => ({}));
  if (!minted.ok || typeof id.secret !== "string") return { status: "error", reason: `mint ${minted.status}` };
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${id.secret}`);
  const auth = { ...H, Authorization: `Bearer ${id.secret}` };
  const made = await fetch(origin + "/api/agent-rooms", { method: "POST", headers: auth, body: JSON.stringify({ title: "qa-preview-parity", purpose: "Preview parity probes" }) });
  const room = await made.json().catch(() => ({}));
  const roomId = room.roomId ?? room.room?.id ?? room.room?.roomId;
  if (!made.ok || !roomId) return { status: "error", reason: `room ${made.status}` };
  const { runProbes } = await import(pathToFileURL(probesPath).href);
  const out = await runProbes({ origin, secret: id.secret, mcpSecret: id.secret, roomId, repo });
  const count = s => out.rows.filter(r => r.status === s).length;
  return { status: "ran", roomId, parity: count("parity"), partial: count("partial"), missing: count("missing"), rows: out.rows.map(r => ({ cap: r.cap, status: r.status })) };
}

export const COMMENT_MARKER = "<!-- room-pr-preview -->";
export function commentBody({ pr, origin, sha, smoke, parity, deleted = false }) {
  if (deleted) return `${COMMENT_MARKER}\n**Preview** \`${previewName(pr)}\` deleted (PR closed).`;
  const smokeLine = !smoke ? "not run" : smoke.ok ? "pass" : `fail (${(smoke.findings ?? []).filter(f => f.severity === "fail").map(f => f.code ?? f.kind ?? "finding").join(", ") || "see run"})`;
  const parityLine = !parity ? "not run" : parity.status === "ran" ? `${parity.parity} parity / ${parity.partial} partial / ${parity.missing} missing` : `${parity.status}: ${parity.reason}`;
  return [COMMENT_MARKER, `**Preview** for ${sha.slice(0, 7)}: ${origin}`, "",
    `- Smoke (live-smoke --isolated): ${smokeLine}`, `- Linear parity probes (#5882): ${parityLine}`, "",
    "Own Worker and Durable Object storage; no production or staging data. Deleted when the PR closes."].join("\n");
}

const readJson = p => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, a, b, c, d] = process.argv.slice(2);
  if (cmd === "config") {
    const cfg = JSON.parse(stripJsonc(readFileSync(join(repo, "cloudflare/wrangler.jsonc"), "utf8")));
    writeFileSync(join(repo, "cloudflare/wrangler.preview.jsonc"), JSON.stringify(previewConfig(cfg, a), null, 1));
    console.log(previewOrigin(a));
  } else if (cmd === "parity") {
    const out = await previewParity(a).catch(e => ({ status: "error", reason: String(e?.message ?? e).slice(0, 200) }));
    if (b) writeFileSync(b, JSON.stringify(out, null, 1));
    console.log(JSON.stringify({ ...out, rows: undefined }));
  } else if (cmd === "comment") {
    process.stdout.write(commentBody({ pr: a, origin: b, sha: process.env.GITHUB_SHA ?? "", smoke: readJson(c), parity: readJson(d) }));
  } else if (cmd === "deleted") {
    process.stdout.write(commentBody({ pr: a, deleted: true }));
  } else { console.error("usage: config|parity|comment|deleted"); process.exit(2); }
}
