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
    if (entry.isDirectory()) {
      if (!packagedPaths.some(file => file.startsWith(path + '/'))) throw new Error(`Unexpected asset output: ${path}`);
      await checkOutput(new URL(entry.name + '/', directory), path + '/');
    } else if (!entry.isFile() || !packagedPaths.includes(path)) throw new Error(`Unexpected asset output: ${path}`);
  }
}
export async function buildAssets(output = new URL('./public/', import.meta.url)) {
  const sources = await Promise.all(packagedPaths.map(async file => {
    const source = new URL('../' + file, import.meta.url);
    if (!(await lstat(source)).isFile()) throw new Error(`Asset source must be a regular file: ${file}`);
    return readFile(source);
  }));
  await checkOutput(output);
  const directories = new Set(packagedPaths.filter(file => file.includes('/')).map(file => file.slice(0, file.lastIndexOf('/') + 1)));
  await Promise.all([...directories].map(dir => mkdir(new URL(dir, output), { recursive: true })));
  await Promise.all(packagedPaths.map((file, index) => writeFile(new URL(file, output), sources[index])));
  return packagedPaths.length;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log(`Prepared ${await buildAssets()} exact application assets; no database, tests or operator files included.`);
}
