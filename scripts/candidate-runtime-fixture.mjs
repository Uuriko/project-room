// Test-only packaging of allowlisted working files. Never a release certificate.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntimePackage } from './runtime-package.mjs';

export function candidateRuntimeFixture(repository, directory) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  const baseline = join(directory, 'head-runtime');
  createRuntimePackage({ repository, commit: head, destination: baseline });
  const paths = new Set(JSON.parse(readFileSync(join(baseline, 'runtime-manifest.json'))).files.map(entry => entry.path));
  paths.add('src/agent-error.mjs');
  paths.add('client/request-notices.mjs');
  paths.add('src/work-help.js'); paths.add('server/work-help.mjs');
  paths.add('client/help-actions.mjs');
  paths.add('server/inbox.mjs');
  paths.add('server/inbox-outbox.mjs'); paths.add('server/inbox-transport.mjs'); paths.add('server/version.mjs');
  paths.add('scripts/stamp-version.mjs');
  paths.add('server/email-envelope.mjs'); paths.add('server/graph-email.mjs'); paths.add('server/email-import.mjs');
  paths.add('server/graph-fixture-sync.mjs');
  paths.add('server/graph-reply-draft.mjs');
  paths.add('server/graph-reply-journal.mjs');
  paths.add('server/graph-reply-update-review.mjs');
  paths.add('src/inbox-client.js'); paths.add('src/inbox-ui.js');
  paths.add('src/inbox-send-ui.js');
  paths.add('src/room-roster.js');
  const candidate = join(directory, 'synthetic-source'); mkdirSync(candidate);
  // No private state, credentials, docs or real checkout Git metadata.
  for (const path of paths) {
    mkdirSync(join(candidate, path, '..'), { recursive: true });
    cpSync(join(repository, path), join(candidate, path));
  }
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'init.templateDir=', '-c', 'user.name=Room fixture', '-c', 'user.email=fixture@example.invalid', ...args],
  { cwd: candidate, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('add', '--', ...paths); git('commit', '-qm', 'Synthetic candidate packaging fixture');
  return { repository: candidate, commit: git('rev-parse', 'HEAD').trim() };
}
