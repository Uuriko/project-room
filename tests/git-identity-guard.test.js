// git-identity-guard (WAVE-300 FIX-50).
//
// Fail-first acceptance: a repo-local (shared) identity in a checkout that
// has linked worktrees must FAIL the guard loudly, because --local identity
// in the main checkout bleeds into every sibling worktree (observed: a
// sibling agent's user.name silently overwrote the experimenter's in a
// linked worktree). Per-worktree identity (--worktree scope) or env-var
// identity (GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL) must PASS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/git-identity-guard.mjs', import.meta.url));

function tmpRoot(t) {
  // TMPDIR-aware: /tmp is a near-full 512MB tmpfs shared by all agents;
  // run with TMPDIR pointed at the worktree-local .tmp/.
  const base = process.env.TMPDIR || os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, 'git-identity-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, args, env = {}) {
  const r = spawnSync('git', args, {
    cwd,
    env: {
      ...process.env,
      HOME: cwd, // isolate from the operator's real global config
      GIT_CONFIG_NOSYSTEM: '1',
      ...env,
    },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function runGuard(cwd, args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

// Fixture: a "shared checkout" — a main worktree with one linked worktree,
// exactly the layout that burned us.
function sharedCheckout(t) {
  const root = tmpRoot(t);
  const main = path.join(root, 'main');
  fs.mkdirSync(main);
  git(main, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(main, 'f.txt'), 'x\n');
  git(main, ['add', 'f.txt']);
  git(main, ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  const linked = path.join(root, 'linked');
  git(main, ['worktree', 'add', '-q', linked]);
  return { root, main, linked };
}

test('shared checkout + --local identity in main worktree -> guard FAILS with guidance', (t) => {
  const { main, linked } = sharedCheckout(t);
  git(main, ['config', 'user.name', 'Sibling Agent']);
  git(main, ['config', 'user.email', 'sibling@example.com']);

  const r = runGuard(linked, ['check']);
  assert.notEqual(r.status, 0, 'guard must fail on shared --local identity');
  const out = r.stdout + r.stderr;
  assert.match(out, /--worktree/, 'guidance must mention --worktree scope');
  assert.match(out, /GIT_AUTHOR_NAME/, 'guidance must mention GIT_AUTHOR_NAME');
  assert.match(out, /GIT_AUTHOR_EMAIL/, 'guidance must mention GIT_AUTHOR_EMAIL');
});

test('per-worktree identity -> guard PASSES', (t) => {
  const { main, linked } = sharedCheckout(t);
  git(main, ['config', 'extensions.worktreeConfig', 'true']); // prerequisite for --worktree writes
  git(linked, ['config', '--worktree', 'user.name', 'Lane Worker']);
  git(linked, ['config', '--worktree', 'user.email', 'lane@example.com']);

  const r = runGuard(linked, ['check']);
  assert.equal(r.status, 0, `guard must pass on per-worktree identity: ${r.stdout}${r.stderr}`);
});

test('env-var identity -> guard PASSES even with a shared --local identity present', (t) => {
  const { main, linked } = sharedCheckout(t);
  git(main, ['config', 'user.name', 'Sibling Agent']);
  git(main, ['config', 'user.email', 'sibling@example.com']);

  const r = runGuard(linked, ['check'], {
    GIT_AUTHOR_NAME: 'Env Worker',
    GIT_AUTHOR_EMAIL: 'env@example.com',
  });
  assert.equal(r.status, 0, `guard must pass on env identity: ${r.stdout}${r.stderr}`);
});

test('single-worktree repo + --local identity -> guard PASSES (no collision risk)', (t) => {
  const root = tmpRoot(t);
  const repo = path.join(root, 'solo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Solo Dev']);
  git(repo, ['config', 'user.email', 'solo@example.com']);

  const r = runGuard(repo, ['check']);
  assert.equal(r.status, 0, `guard must pass for a lone worktree: ${r.stdout}${r.stderr}`);
});

test('missing identity -> guard FAILS with guidance', (t) => {
  const root = tmpRoot(t);
  const repo = path.join(root, 'noid');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  const r = runGuard(repo, ['check'], {
    HOME: repo, // hide the operator's real ~/.gitconfig identity
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: '', // make sure env identity cannot rescue this case
    GIT_AUTHOR_EMAIL: '',
  });
  assert.notEqual(r.status, 0, 'guard must fail when no identity is configured');
  const out = r.stdout + r.stderr;
  assert.match(out, /missing/, 'failure must say identity is missing');
  assert.match(out, /GIT_AUTHOR_NAME/, 'guidance must mention GIT_AUTHOR_NAME');
});

test('set subcommand writes identity at worktree scope', (t) => {
  const { linked } = sharedCheckout(t);
  const r = runGuard(linked, ['set', 'Worktree Worker', 'worker@example.com']);
  assert.equal(r.status, 0, `set must succeed: ${r.stdout}${r.stderr}`);

  const origin = git(linked, ['config', '--show-origin', '--get', 'user.name']);
  assert.match(origin, /config\.worktree/, 'identity must live in a config.worktree file');
  assert.equal(git(linked, ['config', '--worktree', '--get', 'user.name']), 'Worktree Worker');
  assert.equal(git(linked, ['config', '--worktree', '--get', 'user.email']), 'worker@example.com');

  // ...and the guard must pass after a set.
  const after = runGuard(linked, ['check']);
  assert.equal(after.status, 0, `guard must pass after set: ${after.stdout}${after.stderr}`);
});
