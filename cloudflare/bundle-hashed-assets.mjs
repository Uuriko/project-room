// Minify and content-hash the browser entries into public/a/.
// Each page gets its own file. Dynamic imports that gate a later screen
// (the room, the board, the sign-in continuation) stay separate files, so
// the first screen does not download them. Those imports are relative
// (`./app-<hash>.js`). An absolute `/a/` path would miss the www door,
// whose worker route is `/room*` and whose pages load `{{ASSET_BASE}}/a/…`.
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STYLESHEETS = [
  'src/styles.css', 'src/login-polish.css', 'src/board.css', 'src/public-a11y.css',
  'src/human-experience.css', 'src/project-offers.css', 'src/operator.css'
];
const HTML_PAGES = ['index.html', 'join.html', 'agent-signin.html', 'offers.html', 'operator.html'];

// Later screens. Built before the files that import them, so the importer
// can name the hashed output.
const LAZY = [
  ['agent-ui', 'src/agent-signin-ui.js', []],
  ['board', 'src/board-ui.js', []],
  ['board-keys', 'src/board-keyboard.mjs', []],
  ['account', 'src/account-client.js', []],
  ['access', 'src/request-access.js', []],
  ['signin', 'src/signin-entry.js', ['src/agent-signin-ui.js']],
  ['app', 'src/app.js', ['src/board-ui.js', 'src/board-keyboard.mjs']],
  ['entry', 'src/entry.js', ['src/account-client.js', 'src/app.js', 'src/request-access.js', 'src/signin-entry.js']],
  ['join', 'src/join.js', []],
  ['agent-signin', 'src/agent-signin-page.js', []],
  ['operator', 'src/operator-ui.js', []],
  ['offers', 'src/project-offers-ui.js', []]
];

function lazyPlugin(specifiers) {
  return {
    name: 'lazy-hashed',
    setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        if (args.kind !== 'dynamic-import') return;
        const spec = specifiers.get(relative(ROOT, resolve(args.resolveDir, args.path)));
        if (spec) return { path: spec, external: true };
      });
    }
  };
}

async function bundleEntry(esbuild, outdir, name, entry, specifiers) {
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: { [name]: entry },
    bundle: true,
    splitting: false,
    format: name === 'join-watchdog' ? 'iife' : 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    charset: 'utf8',
    legalComments: 'none',
    outdir,
    entryNames: '[name]-[hash]',
    metafile: true,
    write: true,
    plugins: [lazyPlugin(specifiers)]
  });
  const file = Object.keys(result.metafile.outputs).find(path => result.metafile.outputs[path].entryPoint === entry);
  if (!file) throw new Error(`missing hashed output for ${entry}`);
  return `a/${basename(file)}`;
}

export function rewriteAssetHtml(html, map) {
  return html.replace(/(href|src)(\s*=\s*)(["'])([^"']+)\3/g, (full, attr, eq, quote, url) => {
    let prefix = '';
    let bare = url;
    if (bare.startsWith('{{ASSET_BASE}}/')) {
      prefix = '{{ASSET_BASE}}/';
      bare = bare.slice('{{ASSET_BASE}}/'.length);
    } else if (bare.startsWith('./')) {
      prefix = './';
      bare = bare.slice(2);
    } else if (bare.startsWith('/')) {
      prefix = '/';
      bare = bare.slice(1);
    } else return full;
    const next = map.get(bare);
    return next ? `${attr}${eq}${quote}${prefix}${next}${quote}` : full;
  });
}

export async function bundleHashedAssets(output) {
  const esbuild = await import('esbuild');
  const outdir = fileURLToPath(new URL('a/', output));
  await mkdir(outdir, { recursive: true });
  const map = new Map();
  const specifiers = new Map();
  for (const [name, entry, lazy] of LAZY) {
    const hashed = await bundleEntry(esbuild, outdir, name, entry, specifiers);
    map.set(entry, hashed);
    specifiers.set(entry, `./${basename(hashed)}`);
    for (const source of lazy) if (!specifiers.has(source)) throw new Error(`${entry} externalizes ${source} before it is built`);
  }
  const watchdog = await bundleEntry(esbuild, outdir, 'join-watchdog', 'src/join-watchdog.js', specifiers);
  map.set('src/join-watchdog.js', watchdog);

  let cssBytes = 0;
  for (const sheet of STYLESHEETS) {
    const source = await readFile(new URL(`../${sheet}`, import.meta.url), 'utf8');
    const { code } = await esbuild.transform(source, { loader: 'css', minify: true, charset: 'utf8', legalComments: 'none' });
    if (sheet === 'src/styles.css' && !code.includes('/og/fonts/Inter-Regular.woff2')) {
      throw new Error('minified styles.css dropped the wordmark font URL');
    }
    const hash = createHash('sha256').update(code).digest('hex').slice(0, 10);
    const name = `${basename(sheet, '.css')}-${hash}.css`;
    await writeFile(new URL(name, new URL('a/', output)), code);
    cssBytes += Buffer.byteLength(code);
    map.set(sheet, `a/${name}`);
  }

  const frontDoor = new URL('src/front-door.js', output);
  const front = await readFile(frontDoor, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (front != null) {
    const { code } = await esbuild.transform(front, { minify: true, target: 'es2022', charset: 'utf8', legalComments: 'none' });
    if (!code.includes('/api/public/front-door')) throw new Error('minified front-door.js dropped its feed');
    await writeFile(frontDoor, code);
  }

  for (const page of HTML_PAGES) {
    const url = new URL(page, output);
    const rewritten = rewriteAssetHtml(await readFile(url, 'utf8'), map);
    if (rewritten.includes('src/entry.js') || rewritten.includes('src/join.js') || rewritten.includes('src/styles.css')) {
      throw new Error(`${page} still points at an unhashed entry or stylesheet`);
    }
    await writeFile(url, rewritten);
  }

  const names = await readdir(outdir);
  let jsBytes = 0;
  const scripts = [];
  for (const name of names) {
    if (!name.endsWith('.js')) continue;
    const text = await readFile(new URL(name, new URL('a/', output)), 'utf8');
    scripts.push(text);
    jsBytes += Buffer.byteLength(text);
    if (/(?:from|import\()\s*["']\//.test(text)) throw new Error(`${name} imports an absolute URL`);
  }
  if (!map.get('src/entry.js')) throw new Error('hashed entry bundle is missing');
  if (!scripts.some(text => text.includes('../push-sw.js'))) throw new Error('hashed graph dropped the relative push service worker URL');
  return { files: names.length, jsBytes, cssBytes, map: Object.fromEntries(map) };
}
