// Bundle the browser entries into minified, content-hashed chunks.
// The Worker build runs this after cloudflare/build-assets.mjs. Dev
// (`npm start`) does not: it keeps serving the raw modules under /src.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { isPackagedClientAsset } from "../server/client-assets.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// `from` is the reference in the source HTML. `prefix` is what replaces
// the directory, so a prefixed door keeps {{ASSET_BASE}} in front.
export const CLIENT_HTML_ENTRIES = Object.freeze([
  { source: "src/entry.js", html: "index.html", from: "./src/entry.js", prefix: "./" },
  { source: "src/project-offers-ui.js", html: "offers.html", from: "/src/project-offers-ui.js", prefix: "/" },
  { source: "src/operator-ui.js", html: "operator.html", from: "/src/operator-ui.js", prefix: "/" },
  { source: "src/join.js", html: "join.html", from: "{{ASSET_BASE}}/src/join.js", prefix: "{{ASSET_BASE}}/" },
  { source: "src/agent-signin-page.js", html: "agent-signin.html", from: "{{ASSET_BASE}}/src/agent-signin-page.js", prefix: "{{ASSET_BASE}}/" },
]);
export const CLIENT_CLASSIC_ENTRIES = Object.freeze([
  { source: "src/join-watchdog.js", html: "join.html", from: "{{ASSET_BASE}}/src/join-watchdog.js", prefix: "{{ASSET_BASE}}/" },
]);

const specifierPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.[^"']+)["']/g;

export function sourceModuleGraph(entry = "src/entry.js") {
  const seen = new Set();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(join(repoRoot, file), "utf8");
    for (const match of source.matchAll(specifierPattern)) {
      let next = posix.normalize(posix.join(posix.dirname(file), match[1]));
      if (!next.endsWith(".js") && !next.endsWith(".mjs")) next += ".js";
      pending.push(next);
    }
  }
  return [...seen].sort();
}

export function byteSize(files) {
  let rawBytes = 0;
  let gzipBytes = 0;
  for (const file of files) {
    const bytes = typeof file === "string" ? readFileSync(join(repoRoot, file)) : file;
    rawBytes += bytes.length;
    gzipBytes += gzipSync(bytes).length;
  }
  return { files: files.length, rawBytes, gzipBytes };
}

function outputDirectory(output) {
  if (output instanceof URL) return fileURLToPath(output);
  if (typeof output === "string") return output;
  return fileURLToPath(new URL("../cloudflare/public/", import.meta.url));
}

function publicPath(outfile) {
  const normalized = outfile.split("\\").join("/");
  const at = normalized.lastIndexOf("assets/");
  if (at < 0) throw new Error(`Client bundle wrote outside assets/: ${outfile}`);
  return normalized.slice(at);
}

async function bundle(entryPoints, outdir, format) {
  return esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints,
    outdir,
    outbase: "src",
    bundle: true,
    splitting: format === "esm",
    format,
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    charset: "utf8",
    entryNames: "[name]-[hash]",
    chunkNames: "[name]-[hash]",
    assetNames: "[name]-[hash]",
    metafile: true,
    write: true,
    logLevel: "silent",
  });
}

function rewriteHtml(html, replacements) {
  let next = html;
  for (const [from, to] of replacements) {
    if (!next.includes(from)) throw new Error(`HTML is missing ${from}`);
    next = next.replaceAll(from, to);
  }
  return next;
}

export async function buildClient(output) {
  const outputDir = outputDirectory(output);
  const assetsDir = join(outputDir, "assets");
  await rm(assetsDir, { recursive: true, force: true });
  await mkdir(assetsDir, { recursive: true });
  const modules = await bundle(CLIENT_HTML_ENTRIES.map(entry => entry.source), assetsDir, "esm");
  const classic = await bundle(CLIENT_CLASSIC_ENTRIES.map(entry => entry.source), assetsDir, "iife");
  const entries = {};
  for (const meta of [modules.metafile, classic.metafile]) {
    for (const [outfile, info] of Object.entries(meta.outputs)) {
      if (!info.entryPoint) continue;
      const path = publicPath(outfile);
      if (!isPackagedClientAsset(path)) throw new Error(`Unexpected client bundle name: ${path}`);
      entries[info.entryPoint] = path;
    }
  }
  for (const entry of [...CLIENT_HTML_ENTRIES, ...CLIENT_CLASSIC_ENTRIES]) {
    if (!entries[entry.source]) throw new Error(`Missing bundle for ${entry.source}`);
  }
  const byHtml = new Map();
  for (const entry of [...CLIENT_HTML_ENTRIES, ...CLIENT_CLASSIC_ENTRIES]) {
    const list = byHtml.get(entry.html) ?? [];
    list.push([entry.from, entry.prefix + entries[entry.source]]);
    byHtml.set(entry.html, list);
  }
  for (const [html, replacements] of byHtml) {
    const source = await readFile(join(repoRoot, html), "utf8");
    await writeFile(join(outputDir, html), rewriteHtml(source, replacements));
  }
  const names = (await readdir(assetsDir)).sort();
  const files = [];
  for (const name of names) {
    const path = `assets/${name}`;
    if (!isPackagedClientAsset(path)) throw new Error(`Unexpected client bundle name: ${path}`);
    const bytes = await readFile(join(assetsDir, name));
    const text = bytes.toString("utf8");
    if (text.includes(repoRoot)) throw new Error(`${path} embeds a local filesystem path`);
    if (text.includes("push-sw") && !text.includes("../push-sw.js")) {
      throw new Error(`${path} moved the service worker off /push-sw.js`);
    }
    files.push({ path, bytes: bytes.length, gzipBytes: gzipSync(bytes).length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const rawBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const gzipBytes = files.reduce((sum, file) => sum + file.gzipBytes, 0);
  return { outputDir, entries, files, rawBytes, gzipBytes };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const built = await buildClient(process.argv[2]);
  console.log(JSON.stringify({
    files: built.files.length,
    rawBytes: built.rawBytes,
    gzipBytes: built.gzipBytes,
    entries: built.entries,
  }));
}
