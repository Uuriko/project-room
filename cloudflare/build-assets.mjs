import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export const assetPaths = ['index.html', ...['app.js', 'client.js', 'events.js', 'conversation.js', 'workflow.js',
  'share-links.js', 'return-brief.js', 'work-selectors.js', 'work-status.js', 'work-packet.js', 'portable-work.js', 'reminders.js', 'reminder-time.js', 'styles.css', 'agent-connections.js', 'room-charter.js', 'room-instructions.js', 'reply-requests.js', 'work-help.js', 'help-offers.js', 'inbox-client.js', 'inbox-ui.js', 'inbox-quarantine-ui.js', 'inbox-send-ui.js', 'room-roster.js', 'account-settings-ui.js', 'auth-signin-ui.js', 'invite-context.js', 'room-deep-link.js', 'browser-session.js', 'agent-invite-ui.js', 'work-item-session.js', 'work-loops.js', 'work-recipes.js', 'share-invite-code.js', 'handoff-envelope-ui.js'].map(file => 'src/' + file), 'connectors/muse.md'];

// Fail closed on unexpected output instead of uploading or deleting unknown files.
async function checkOutput(directory, prefix = '') {
  const info = await lstat(resolve(fileURLToPath(directory))).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Asset output must be a real directory');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory() && path === 'src') await checkOutput(new URL('src/', directory), 'src/');
    else if (entry.isDirectory() && path === 'connectors') await checkOutput(new URL('connectors/', directory), 'connectors/');
    else if (!entry.isFile() || !assetPaths.includes(path)) throw new Error(`Unexpected asset output: ${path}`);
  }
}
export async function buildAssets(output = new URL('./public/', import.meta.url)) {
  const sources = await Promise.all(assetPaths.map(async file => {
    const source = new URL('../' + file, import.meta.url);
    if (!(await lstat(source)).isFile()) throw new Error(`Asset source must be a regular file: ${file}`);
    return readFile(source);
  }));
  await checkOutput(output);
  await mkdir(new URL('src/', output), { recursive: true });
  await mkdir(new URL('connectors/', output), { recursive: true });
  await Promise.all(assetPaths.map((file, index) => writeFile(new URL(file, output), sources[index])));
  return assetPaths.length;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log(`Prepared ${await buildAssets()} exact application assets; no database, tests or operator files included.`);
}
