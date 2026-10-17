// Test-only packaging of allowlisted working files. Never a release certificate.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntimePackage, allowed } from './runtime-package.mjs';
import { publicAssetPaths, generatedAgentPages } from '../server/public-assets.mjs';

export function candidateRuntimeFixture(repository, directory) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  const baseline = join(directory, 'head-runtime');
  createRuntimePackage({ repository, commit: head, destination: baseline });
  const paths = new Set(JSON.parse(readFileSync(join(baseline, 'runtime-manifest.json'))).files.map(entry => entry.path));
  // The existing runtime allowlist owns candidate membership too. Include new
  // working files without maintaining a second handwritten deployment list.
  // Baseline paths remain mandatory below; historical optional paths may be
  // absent in the current checkout. Only explicitly allowlisted files enter.
  for (const path of allowed) if (existsSync(join(repository, path))) paths.add(path);
  // Decision #36 (#3254, Option A): the generated agent pages are build
  // output and are never committed, so a pristine checkout legitimately
  // lacks them. Take only the pages the source tree actually has: the
  // runtime package ships them when present and omits them when absent,
  // and packagedPaths must mirror that exact set for the package-count
  // contract in tests/runtime-package.test.js. Every other declared asset
  // stays fail-closed — a missing committed file still throws at the
  // copy loop below.
  for (const path of publicAssetPaths) {
    if (generatedAgentPages.includes(path) && !existsSync(join(repository, path))) continue;
    paths.add(path);
  }
  const candidate = join(directory, 'synthetic-source'); mkdirSync(candidate);
  // Only allowlisted runtime/public assets; never arbitrary working files or Git metadata.
  for (const path of paths) {
    mkdirSync(join(candidate, path, '..'), { recursive: true });
    cpSync(join(repository, path), join(candidate, path));
  }
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'init.templateDir=', '-c', 'user.name=Room fixture', '-c', 'user.email=fixture@example.invalid', ...args],
  { cwd: candidate, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('add', '--', ...paths); git('commit', '-qm', 'Synthetic candidate packaging fixture');
  // packagedPaths is the exact file set committed to the synthetic fixture.
  // Tests derive expected package counts from it (intersected with the
  // runtime-package allowlist) so registering a new module never requires a
  // hand-bumped count (regression guard for #590/#592/#606).
  return { repository: candidate, commit: git('rev-parse', 'HEAD').trim(), packagedPaths: paths };
}
