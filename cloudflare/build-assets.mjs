import { mkdir, readFile, writeFile, readdir, lstat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { publicAssetPaths, templateAssetPaths, generatedAgentPages } from '../server/public-assets.mjs';
export const assetPaths = publicAssetPaths;
const packagedPaths = [...publicAssetPaths, ...templateAssetPaths];

// Fail closed on unexpected output instead of uploading or deleting unknown files.
async function checkOutput(directory, prefix = '') {
  const info = await lstat(resolve(fileURLToPath(directory))).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Asset output must be a real directory');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) {
      if (!packagedPaths.some(file => file.startsWith(path + '/'))) throw new Error(`Unexpected asset output: ${path}`);
      await checkOutput(new URL(entry.name + '/', directory), path + '/');
    } else if (!entry.isFile() || !packagedPaths.includes(path)) throw new Error(`Unexpected asset output: ${path}`);
  }
}
// Decision #36 (#3254, Option A): docs/agents/*.html are generated build
// output (scripts/build-agent-docs.mjs), never committed. A wrangler build
// generates them before this runs, so they are present at deploy time; an
// exact-commit runtime package does not contain them, and building assets
// from inside a package skips the absent pages. Any other missing or
// non-regular source remains an error.
export async function buildAssets(output = new URL('./public/', import.meta.url)) {
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
    return readFile(source);
  }));
  await checkOutput(output);
  const directories = new Set(present.filter(file => file.includes('/')).map(file => file.slice(0, file.lastIndexOf('/') + 1)));
  await Promise.all([...directories].map(dir => mkdir(new URL(dir, output), { recursive: true })));
  await Promise.all(present.map((file, index) => writeFile(new URL(file, output), sources[index])));
  return present.length;
}

const HASHED_FILE = /^[A-Za-z0-9._-]{8,128}\.(?:js|css)$/;

// The files a rolled-back document still names. `a/generation.json` lists the
// generation this output just wrote. The build keeps that list from the
// previous run and drops anything older, so one rollback still resolves and
// the directory does not accumulate every historical hash.
async function previousHashedGeneration(output) {
  const dir = new URL('a/', output);
  let names;
  try { names = await readdir(dir); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  let listed = null;
  try { listed = JSON.parse(await readFile(new URL('generation.json', dir), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const keep = Array.isArray(listed) && listed.every(name => typeof name === 'string')
    ? listed
    : names.filter(name => HASHED_FILE.test(name));
  const saved = [];
  for (const name of keep) {
    if (!HASHED_FILE.test(name)) continue;
    const bytes = await readFile(new URL(name, dir)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (bytes) saved.push({ name, bytes });
  }
  return saved;
}

export function requireHashedBundler(bundler = new URL('./bundle-hashed-assets.mjs', import.meta.url)) {
  if (!existsSync(fileURLToPath(bundler))) {
    throw new Error('cloudflare/bundle-hashed-assets.mjs is missing. Refusing to deploy unbundled assets.');
  }
  return bundler;
}

// Deploy build only. `buildAssets` stays an exact copy: the runtime package
// and the asset tests compare those bytes, and a stray `a/` fails checkOutput
// on the next build. The bundler is loaded by URL, not a literal import,
// because esbuild is a deploy tool and is not part of the exact-commit package.
// A missing bundler fails the build. There is no unbundled fallback.
export async function prepareHostedAssets(output = new URL('./public/', import.meta.url)) {
  const previous = await previousHashedGeneration(output);
  await rm(new URL('a', output), { recursive: true, force: true });
  const copied = await buildAssets(output);
  const bundler = requireHashedBundler();
  const { bundleHashedAssets } = await import(bundler.href);
  const hashed = await bundleHashedAssets(output);
  const dir = new URL('a/', output);
  for (const file of previous) {
    const dest = new URL(file.name, dir);
    if (existsSync(fileURLToPath(dest))) continue;
    await writeFile(dest, file.bytes);
  }
  const current = Object.values(hashed.map).map(path => path.slice(path.lastIndexOf('/') + 1));
  await writeFile(new URL('generation.json', dir), JSON.stringify(current));
  return { copied, hashed };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { copied, hashed } = await prepareHostedAssets();
  const hashedNote = hashed ? `; ${hashed.files} hashed files under a/ (${hashed.jsBytes} B js, ${hashed.cssBytes} B css)` : '';
  console.log(`Prepared ${copied} exact application assets${hashedNote}; no database or tests included.`);
}
