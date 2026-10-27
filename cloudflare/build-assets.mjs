import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { publicAssetPaths, templateAssetPaths, generatedAgentPages, clientBundleEntries, isClientBundlePath } from '../server/public-assets.mjs';
export const assetPaths = publicAssetPaths;
const packagedPaths = [...publicAssetPaths, ...templateAssetPaths];

// Fail closed on unexpected output instead of uploading or deleting unknown files.
async function checkOutput(directory, allowedPaths, prefix = '') {
  const info = await lstat(resolve(fileURLToPath(directory))).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Asset output must be a real directory');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) {
      if (!allowedPaths.some(file => file.startsWith(path + '/'))) throw new Error(`Unexpected asset output: ${path}`);
      await checkOutput(new URL(entry.name + '/', directory), allowedPaths, path + '/');
    } else if (!entry.isFile() || !allowedPaths.includes(path)) throw new Error(`Unexpected asset output: ${path}`);
  }
}

// Client bundles (tranche-2 item 1): cloudflare/build-client.mjs writes
// content-hashed bundles plus a manifest pinning every output by served
// path, byte length and sha256. When that manifest is present, the bundles
// are packaged beside the source assets and their bytes must match the
// manifest exactly (bundle-manifest-exact); any drift fails the build
// closed. When it is absent — a plain checkout, or the exact-commit runtime
// package, which contains no generated output — nothing here runs and every
// asset stays unbundled and source-exact, the pre-bundle contract.
async function loadClientBundles(clientDist) {
  let raw;
  try { raw = await readFile(new URL('manifest.json', clientDist), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const manifest = JSON.parse(raw);
  if (manifest?.version !== 1 || typeof manifest.entries !== 'object' || !Array.isArray(manifest.files))
    throw new Error('Client bundle manifest has an unsupported shape');
  const entryNames = Object.keys(manifest.entries).sort();
  if (JSON.stringify(entryNames) !== JSON.stringify([...clientBundleEntries].sort()))
    throw new Error('Client bundle manifest does not name exactly the client bundle entries');
  const seen = new Set();
  const files = [];
  for (const file of manifest.files) {
    if (typeof file?.path !== 'string' || !isClientBundlePath(file.path) || seen.has(file.path)
      || !Number.isSafeInteger(file.bytes) || typeof file.sha256 !== 'string')
      throw new Error('Client bundle manifest names an invalid bundle file');
    seen.add(file.path);
    const bytes = await readFile(new URL(file.path, clientDist));
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      throw new Error(`Client bundle bytes drifted from the bundle manifest: ${file.path}`);
    files.push({ path: file.path, bytes });
  }
  for (const bundle of Object.values(manifest.entries))
    if (!seen.has(bundle)) throw new Error(`Client bundle manifest entry has no pinned file: ${bundle}`);
  return { entries: manifest.entries, files };
}

// Point a packaged page at the bundle for each entry it names. Only the
// exact quoted references are rewritten ("./src/entry.js", "/src/entry.js"),
// preserving the reference's own form; every other byte is the source byte.
function rewriteEntryReferences(bytes, entries) {
  let text = bytes.toString('utf8');
  for (const [source, bundle] of Object.entries(entries)) {
    text = text.split(`"./${source}"`).join(`"./${bundle}"`);
    text = text.split(`"/${source}"`).join(`"/${bundle}"`);
  }
  return Buffer.from(text, 'utf8');
}

// Decision #36 (#3254, Option A): docs/agents/*.html are generated build
// output (scripts/build-agent-docs.mjs), never committed. A wrangler build
// generates them before this runs, so they are present at deploy time; an
// exact-commit runtime package does not contain them, and building assets
// from inside a package skips the absent pages. Any other missing or
// non-regular source remains an error.
export async function buildAssets(output = new URL('./public/', import.meta.url), clientDist = new URL('./client-dist/', import.meta.url)) {
  const bundles = await loadClientBundles(clientDist);
  const present = [];
  for (const file of packagedPaths) {
    const isFile = await lstat(new URL('../' + file, import.meta.url)).then(info => info.isFile(), error => {
      if (error.code === 'ENOENT' && generatedAgentPages.includes(file)) return false;
      throw error;
    });
    if (isFile) present.push(file);
  }
  const sources = await Promise.all(present.map(async file => {
    const source = new URL('../' + file, import.meta.url);
    if (!(await lstat(source)).isFile()) throw new Error(`Asset source must be a regular file: ${file}`);
    const bytes = await readFile(source);
    return bundles && file.endsWith('.html') ? rewriteEntryReferences(bytes, bundles.entries) : bytes;
  }));
  const allowedPaths = bundles ? [...packagedPaths, ...bundles.files.map(file => file.path)] : packagedPaths;
  await checkOutput(output, allowedPaths);
  const directories = new Set([...present, ...(bundles?.files.map(file => file.path) ?? [])]
    .filter(file => file.includes('/')).map(file => file.slice(0, file.lastIndexOf('/') + 1)));
  await Promise.all([...directories].map(dir => mkdir(new URL(dir, output), { recursive: true })));
  await Promise.all(present.map((file, index) => writeFile(new URL(file, output), sources[index])));
  if (bundles) await Promise.all(bundles.files.map(file => writeFile(new URL(file.path, output), file.bytes)));
  return present.length + (bundles?.files.length ?? 0);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log(`Prepared ${await buildAssets()} exact application assets; no database, tests or operator files included.`);
}
