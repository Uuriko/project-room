// Bundle validation without production key custody. This command always uses
// --dry-run; the real deployment config continues to require a signed card.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.argv.length !== 2) throw new Error('worker-ci-build accepts no deployment arguments');
const directory = fileURLToPath(new URL('../cloudflare/', import.meta.url));
const config = JSON.parse(readFileSync(join(directory, 'wrangler.jsonc'), 'utf8'));
const signer = 'node ../scripts/sign-agent-card.mjs';
if (!config.build.command.includes(signer) || config.build.command.includes('--allow-unsigned')) throw new Error('Unexpected signing build configuration');
config.build.command = config.build.command.replace(signer, signer + ' --allow-unsigned');
const path = join(directory, `.ci-dry-run-${process.pid}.json`);
try {
  writeFileSync(path, JSON.stringify(config), { flag: 'wx' });
  const result = spawnSync(process.execPath, [join(directory, 'node_modules/wrangler/bin/wrangler.js'),
    'deploy', '--config', path, '--dry-run', '--outdir', 'dist'], { cwd: directory, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { unlinkSync(path); }
