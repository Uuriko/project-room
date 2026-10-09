#!/usr/bin/env node
// git-identity-guard — WAVE-300 FIX-50.
//
// Never `git config` identity in a shared checkout/worktree. A `git config
// user.name` / `user.email` at the default (--local) scope in the MAIN
// worktree of a shared tree writes to the common config, which every linked
// worktree inherits — observed: a sibling agent's user.name silently
// overwrote the experimenter's in a linked worktree. Set identity per
// worktree (`git config --worktree`, via the `set` subcommand) or via env
// (`GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL`) instead.
//
// Commands:
//   check        detect a shared --local identity and fail loudly (default)
//   set <name> <email>
//                write identity at --worktree scope for the current worktree
//
// Exit: 0 = ok, 1 = guard violation (or missing identity), 2 = usage error.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

function usage() {
  console.error(
    'usage: node scripts/git-identity-guard.mjs [check] | set <name> <email>\n' +
      '  check  fail loudly if repo identity comes from a shared (--local) config\n' +
      '         in a checkout with linked worktrees\n' +
      '  set    write user.name/user.email at --worktree scope for the current worktree'
  );
}

function insideWorkTree() {
  return run('git', ['rev-parse', '--is-inside-work-tree']).status === 0;
}

// Where does a config key resolve from? Returns { value, origin } or null.
// origin is like "file:/abs/path/config", "command line:", or "" (env can't
// be seen here — env is handled separately since GIT_AUTHOR_* never flows
// through `git config`).
function configOrigin(key) {
  const r = run('git', ['config', '--show-origin', '--get', key]);
  if (r.status !== 0) return null;
  const line = r.stdout.trim();
  const tab = line.indexOf('\t');
  if (tab === -1) return { value: line, origin: '' };
  return { value: line.slice(tab + 1), origin: line.slice(0, tab) };
}

function commonDir() {
  const r = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

function worktreeCount() {
  const r = run('git', ['worktree', 'list', '--porcelain']);
  if (r.status !== 0) return 1;
  return r.stdout.split('\n').filter((l) => l.startsWith('worktree ')).length;
}

function originFileOf(origin) {
  return origin.startsWith('file:') ? origin.slice('file:'.length) : null;
}

function check() {
  if (!insideWorkTree()) {
    console.error('git-identity-guard: FAIL — not inside a git work tree; nothing to guard.');
    return 1;
  }

  const envName = process.env.GIT_AUTHOR_NAME;
  const envEmail = process.env.GIT_AUTHOR_EMAIL;
  if (envName && envEmail) {
    console.log(
      `git-identity-guard: PASS — identity comes from env (GIT_AUTHOR_NAME=${envName}, GIT_AUTHOR_EMAIL=${envEmail}); no shared-config collision possible.`
    );
    return 0;
  }

  const common = commonDir();
  const n = worktreeCount();
  const sharedConfigFile = common ? path.join(common, 'config') : null;

  const problems = [];
  for (const key of ['user.name', 'user.email']) {
    const got = configOrigin(key);
    if (!got) {
      problems.push(`missing: no ${key} configured (and GIT_AUTHOR_* not set)`);
      continue;
    }
    const file = originFileOf(got.origin);
    if (file && sharedConfigFile && file === sharedConfigFile && n > 1) {
      problems.push(
        `shared: ${key}="${got.value}" resolves from the SHARED local config ${file} ` +
          `in a checkout with ${n} worktrees`
      );
    }
  }

  if (problems.length === 0) {
    const name = configOrigin('user.name');
    console.log(
      `git-identity-guard: PASS — identity is safely scoped (user.name="${name ? name.value : ''}"` +
        `${name && originFileOf(name.origin) ? ` from ${name.origin}` : ''}; ${n} worktree(s), no shared --local identity).`
    );
    return 0;
  }

  console.error('git-identity-guard: FAIL — unsafe git identity in a shared checkout.');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\nA `git config user.name` (default --local scope) in the main worktree silently\n' +
      'overwrites the identity of EVERY linked worktree. Set identity per-worktree\n' +
      'or via env instead:\n' +
      '\n' +
      '  node scripts/git-identity-guard.mjs set "Your Name" you@example.com\n' +
      '    # runs: git config --worktree user.name ... — writes to config.worktree,\n' +
      '    # scoped to the current worktree only\n' +
      '  # or\n' +
      '  export GIT_AUTHOR_NAME="Your Name" GIT_AUTHOR_EMAIL="you@example.com"\n' +
      '\n' +
      'Rule: never `git config` identity in a shared checkout/worktree.'
  );
  return 1;
}

function setIdentity(name, email) {
  if (!insideWorkTree()) {
    console.error('git-identity-guard: not inside a git work tree.');
    return 2;
  }
  if (!name || !email) {
    usage();
    return 2;
  }
  // Per-worktree identity needs extensions.worktreeConfig in a multi-worktree
  // repo (git refuses --worktree writes without it). This is a repo behavior
  // flag, not identity data, so enabling it here is safe and intentional.
  const ext = run('git', ['config', 'extensions.worktreeConfig', 'true']);
  if (ext.status !== 0) {
    console.error(`git-identity-guard: failed to enable extensions.worktreeConfig: ${ext.stderr.trim()}`);
    return 1;
  }
  for (const [key, value] of [
    ['user.name', name],
    ['user.email', email],
  ]) {
    const r = run('git', ['config', '--worktree', key, value]);
    if (r.status !== 0) {
      console.error(`git-identity-guard: failed to set ${key} at --worktree scope: ${r.stderr.trim()}`);
      return 1;
    }
  }
  console.log(
    `git-identity-guard: set user.name="${name}" user.email="${email}" at --worktree scope (config.worktree, current worktree only).`
  );
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'check') {
  process.exit(check());
} else if (cmd === 'set') {
  process.exit(setIdentity(rest[0], rest[1]));
} else {
  usage();
  process.exit(2);
}
