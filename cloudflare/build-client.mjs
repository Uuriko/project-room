// Client bundle build (tranche-2 item 1): bundles the browser entry modules
// named by clientBundleEntries in server/public-assets.mjs with esbuild —
// splitting, minify, tree-shaking, content-hash file names — into
// cloudflare/client-dist/, generated output that is never committed.
//
// The wrangler deploy build runs this before build-assets.mjs, which reads
// the manifest written here and packages the bundle files beside the exact
// source assets. The manifest is the contract: every output is pinned by
// served path, byte length and sha256, and build-assets fails closed on any
// drift between the manifest and the bytes on disk.
//
// esbuild is a cloudflare-workspace devDependency, so this module only runs
// where that workspace is installed. build-assets.mjs deliberately does NOT
// import it: the exact-commit runtime package runs build-assets from a bare
// package with no node_modules, where an absent manifest simply means "no
// client build ran" and every asset stays unbundled and source-exact.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clientBundleEntries } from '../server/public-assets.mjs';

const distDirectory = new URL('./client-dist/', import.meta.url);
const distSrcDirectory = new URL('./src/', distDirectory);

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

// Remove the previous build's outputs (named by its own manifest) so a
// rehashed entry never leaves a stale bundle behind for build-assets to
// package. Anything the manifest does not name is left alone.
async function cleanPrevious(manifestDirectory) {
  let prior = null;
  try { prior = JSON.parse(await readFile(new URL('manifest.json', manifestDirectory), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!prior) return;
  for (const file of prior.files ?? []) {
    if (typeof file?.path !== 'string' || !file.path.startsWith('src/') || file.path.includes('..')) continue;
    await rm(new URL(file.path, manifestDirectory), { force: true });
  }
}

// Builds the bundles and returns the manifest object. `outDirectory` and
// `manifestDirectory` exist for the cloudflare check, which builds into a
// scratch directory; production callers take the defaults.
export async function buildClient({ outDirectory = distSrcDirectory, manifestDirectory = distDirectory } = {}) {
  await cleanPrevious(manifestDirectory);
  await mkdir(outDirectory, { recursive: true });
  const entryPoints = clientBundleEntries.map(file => fileURLToPath(new URL('../' + file, import.meta.url)));
  const result = await build({
    entryPoints,
    bundle: true, splitting: true, format: 'esm', minify: true, treeShaking: true,
    platform: 'browser', target: ['es2022'],
    outdir: fileURLToPath(outDirectory),
    outbase: fileURLToPath(new URL('../src/', import.meta.url)),
    entryNames: '[name]-[hash]', chunkNames: 'chunk-[hash]',
    metafile: true, logLevel: 'warning',
  });
  const outRoot = resolve(fileURLToPath(outDirectory));
  const files = [];
  const entries = {};
  for (const [outputPath, output] of Object.entries(result.metafile.outputs)) {
    // Every input lives flat in src/, so every output must land flat in the
    // output directory: a nested output would change the served depth and
    // break import.meta.url-relative resolution (src/human-push.js resolves
    // ../push-sw.js against its own URL). Fail closed instead of emitting a
    // bundle whose chunks sit at a different depth than the sources.
    if (resolve(dirname(outputPath)) !== outRoot && resolve(outputPath) !== resolve(outRoot, basename(outputPath)))
      throw new Error(`Client bundle output is not flat in the output directory: ${outputPath}`);
    const name = basename(outputPath);
    const bytes = await readFile(resolve(outRoot, name));
    files.push({ path: 'src/' + name, bytes: bytes.length, sha256: sha256(bytes) });
    // The metafile also marks dynamically imported modules as entry
    // points; the manifest's entries are exactly the declared bundle
    // entries — the dynamic ones are ordinary bundle files, pinned in
    // files[] like every chunk.
    if (output.entryPoint && clientBundleEntries.includes('src/' + basename(output.entryPoint)))
      entries['src/' + basename(output.entryPoint)] = 'src/' + name;
  }
  files.sort((a, b) => a.path < b.path ? -1 : 1);
  for (const entry of clientBundleEntries)
    if (!entries[entry]) throw new Error(`Client bundle build produced no output for entry: ${entry}`);
  const manifest = { version: 1, entries, files };
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(new URL('manifest.json', manifestDirectory), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const manifest = await buildClient();
  const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  console.log(`Built ${manifest.files.length} client bundle files (${total} bytes) with manifest cloudflare/client-dist/manifest.json.`);
}
