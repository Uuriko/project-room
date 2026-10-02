import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { publicAssetPaths, templateAssetPaths } from '../deploy/public-assets.mjs';
export const assetPaths = publicAssetPaths;
const packagedPaths = [...publicAssetPaths, ...templateAssetPaths];

// Fail closed on unexpected output instead of uploading or deleting unknown files.
async function checkOutput(directory, prefix = '') {
  const info = await lstat(resolve(fileURLToPath(directory))).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Asset output must be a real directory');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory() && path === 'src') await checkOutput(new URL('src/', directory), 'src/');
    else if (entry.isDirectory() && path === 'connectors') await checkOutput(new URL('connectors/', directory), 'connectors/');
    else if (entry.isDirectory() && path === 'compare') await checkOutput(new URL('compare/', directory), 'compare/');
    else if (entry.isDirectory() && path === 'og') await checkOutput(new URL('og/', directory), 'og/');
    else if (!entry.isFile() || !packagedPaths.includes(path)) throw new Error(`Unexpected asset output: ${path}`);
  }
}
export async function buildAssets(output = new URL('./public/', import.meta.url)) {
  const sources = await Promise.all(packagedPaths.map(async file => {
    const source = new URL('../' + file, import.meta.url);
    if (!(await lstat(source)).isFile()) throw new Error(`Asset source must be a regular file: ${file}`);
    return readFile(source);
  }));
  await checkOutput(output);
  await mkdir(new URL('src/', output), { recursive: true });
  await mkdir(new URL('connectors/', output), { recursive: true });
  await mkdir(new URL('compare/', output), { recursive: true });
  await mkdir(new URL('og/', output), { recursive: true });
  await Promise.all(packagedPaths.map((file, index) => writeFile(new URL(file, output), sources[index])));
  return packagedPaths.length;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log(`Prepared ${await buildAssets()} exact application assets; no database, tests or operator files included.`);
}
