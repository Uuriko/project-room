#!/usr/bin/env node
// Public Mac packaging is deliberately separate from the ad-hoc development build.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function parseOptions(args) {
  const allowed = new Set(['revision', 'version', 'identity', 'notary-profile', 'output']);
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !allowed.has(key) || key in values || !args[i + 1] || args[i + 1].startsWith('--'))
      throw new Error('Expected unique --revision, --version, --identity, --notary-profile and --output arguments');
    values[key] = args[i + 1];
  }
  if (!/^[a-f0-9]{40}$/.test(values.revision ?? '')) throw new Error('revision must be a full lowercase commit SHA');
  if (!/^\d+\.\d+\.\d+$/.test(values.version ?? '')) throw new Error('version must be major.minor.patch');
  if (!/^[A-Fa-f0-9]{40}$/.test(values.identity ?? '')) throw new Error('identity must be an explicit signing-certificate SHA1 fingerprint');
  if (!values['notary-profile']?.trim()) throw new Error('A configured Keychain notary profile is required');
  if (!isAbsolute(values.output ?? '')) throw new Error('output must be a new absolute directory');
  return values;
}

// Only fixed executables and literal argument arrays; no shell or password flags.
function command(executable, args, cwd = root) {
  return execFileSync(executable, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}

export function assertSource(options, run) {
  if (run('git', ['rev-parse', 'HEAD']).trim() !== options.revision) throw new Error('Source revision does not match the requested release');
  if (run('git', ['status', '--porcelain', '--untracked-files=normal']).trim()) throw new Error('Release requires a clean source tree, including untracked files');
}

export function assertIdentity(options, run) {
  const identities = run('security', ['find-identity', '-v', '-p', 'codesigning']);
  const valid = identities.split('\n').some(line => {
    const match = line.match(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"Developer ID Application: [^"]+"\s*$/);
    return match?.[1].toLowerCase() === options.identity.toLowerCase();
  });
  if (!valid) throw new Error('Requested valid Developer ID Application identity is unavailable; no ad-hoc fallback');
}

export function assertShippingBundle(app, fs) {
  const files = new Set(['Contents/Info.plist', 'Contents/MacOS/ProjectRoom',
    'Contents/MacOS/ProjectRoomTools', 'Contents/Resources/ProjectRoom.icns',
    'Contents/_CodeSignature/CodeResources']);
  const directories = new Set(['Contents', 'Contents/MacOS', 'Contents/Resources', 'Contents/_CodeSignature']);
  const visit = relative => {
    for (const entry of fs.readdirSync(join(app, relative))) {
      const path = relative ? `${relative}/${entry}` : entry;
      const stat = fs.lstatSync(join(app, path));
      if (stat.isSymbolicLink()) throw new Error('Shipping bundle cannot contain symbolic links');
      if (stat.isDirectory() && directories.has(path)) visit(path);
      else if (!stat.isFile() || !files.has(path)) throw new Error(`Unexpected shipping bundle entry: ${path}`);
    }
  };
  visit('');
  for (const file of files) if (!fs.existsSync(join(app, file))) throw new Error(`Missing shipping bundle entry: ${file}`);
}

export function distribute(options, { run = command, platform = process.platform, fs = { existsSync, lstatSync, readdirSync, mkdirSync, readFileSync, writeFileSync } } = {}) {
  if (platform !== 'darwin') throw new Error('Mac distribution must run on macOS');
  assertSource(options, run);
  assertIdentity(options, run);
  run('xcrun', ['notarytool', '--version']);
  if (fs.existsSync(options.output)) throw new Error('Output already exists; use a new release directory');
  fs.mkdirSync(options.output, { mode: 0o700 });
  run('/bin/bash', ['desktop/macos/build.sh']);
  // Re-check before copying/signing: shared or interrupted builds must not publish drift.
  assertSource(options, run);
  const app = join(options.output, 'Project Room.app');
  run('ditto', [join(root, 'desktop/macos/build/Project Room.app'), app]);
  assertShippingBundle(app, fs);
  const plist = join(app, 'Contents/Info.plist');
  const value = key => run('plutil', ['-extract', key, 'raw', '-o', '-', plist]).trim();
  if (value('ProjectRoomSourceRevision') !== options.revision || value('ProjectRoomSourceDirty') !== 'false')
    throw new Error('Built app source provenance does not match the clean release');
  run('plutil', ['-replace', 'CFBundleShortVersionString', '-string', options.version, plist]);
  const helper = join(app, 'Contents/MacOS/ProjectRoomTools');
  const architecture = run('lipo', ['-archs', join(app, 'Contents/MacOS/ProjectRoom')]).trim();
  if (!architecture || run('lipo', ['-archs', helper]).trim() !== architecture) throw new Error('App and helper architectures do not match');
  for (const target of [helper, app]) {
    run('codesign', ['--force', '--sign', options.identity, '--options', 'runtime', '--timestamp', target]);
    run('codesign', ['--verify', '--strict', '--verbose=2', target]);
  }
  const submission = join(options.output, 'notary-submission.zip');
  run('ditto', ['-c', '-k', '--keepParent', app, submission]);
  const notary = JSON.parse(run('xcrun', ['notarytool', 'submit', submission, '--keychain-profile', options['notary-profile'], '--wait', '--timeout', '30m', '--output-format', 'json']));
  if (notary.status !== 'Accepted' || typeof notary.id !== 'string' || !notary.id)
    throw new Error('Notarization was not accepted; no release receipt will be emitted');
  run('xcrun', ['stapler', 'staple', app]);
  run('xcrun', ['stapler', 'validate', app]);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  const archive = join(options.output, `Project-Room-${options.version}-macOS.zip`);
  run('ditto', ['-c', '-k', '--keepParent', app, archive]);
  const bytes = fs.readFileSync(archive);
  const receipt = { format: 1, status: 'notarized', sourceRevision: options.revision,
    version: options.version, platform: 'macOS', architecture,
    minimumMacOS: value('LSMinimumSystemVersion'), build: value('CFBundleVersion'),
    artifact: archive, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    notarySubmissionId: notary.id, createdAt: new Date().toISOString(),
    automaticUpdates: false };
  fs.writeFileSync(join(options.output, 'release-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(distribute(parseOptions(process.argv.slice(2))), null, 2)); }
  catch (error) {
    // Child stderr can include account/provider details. Keep CLI diagnostics bounded.
    console.error(error.status != null ? `Release command failed (exit ${error.status}); no successful release is claimed.` : error.message);
    process.exitCode = 1;
  }
}
