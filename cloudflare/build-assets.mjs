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

// Deploy build only. `buildAssets` stays an exact copy: the runtime package
// and the asset tests compare those bytes, and a stray `a/` fails checkOutput
// on the next build. The bundler is loaded by URL, not a literal import,
// because esbuild is a deploy tool and is not part of the exact-commit package.
export async function prepareHostedAssets(output = new URL('./public/', import.meta.url)) {
  await rm(new URL('a', output), { recursive: true, force: true });
  const copied = await buildAssets(output);
  const bundler = new URL('./bundle-hashed-assets.mjs', import.meta.url);
  if (!existsSync(fileURLToPath(bundler))) return { copied, hashed: null };
  const { bundleHashedAssets } = await import(bundler.href);
  return { copied, hashed: await bundleHashedAssets(output) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { copied, hashed } = await prepareHostedAssets();
  const hashedNote = hashed ? `; ${hashed.files} hashed files under a/ (${hashed.jsBytes} B js, ${hashed.cssBytes} B css)` : '';
  console.log(`Prepared ${copied} exact application assets${hashedNote}; no database or tests included.`);
}
