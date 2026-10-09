#!/usr/bin/env node
// collision-partition-propose.mjs — GUILD-05 (COORD-300) collision avoidance.
//
// Static partition planner: given N agents and a repo map (path -> weight),
// emit N DISJOINT slice assignments. Report-only: prints the proposal and a
// machine-checkable disjointness proof (via collision-path-normalize.mjs).
// Never assigns the same subtree to two agents, never splits a file.
//
// Why static partitions: the WAVE-1000 22:12 duplicate-launcher incident
// duplicated guilds 05/08/15/18 because two launchers each computed "the"
// partition independently. A single deterministic planner + a disjointness
// proof removes that class of collision before any agent spawns.
//
// Algorithm:
//   1. Build the directory tree under --scope from the map (weights = file
//      counts by default; caller may supply any additive weight).
//   2. Expand: repeatedly split the heaviest splittable node into its
//      children until we hold >= N leaf partitions (or nothing splits).
//   3. Assign leaves to agents with LPT (longest-processing-time first):
//      sort leaves by weight desc, deal each to the currently-lightest agent.
//      LPT is a 4/3-approximation for makespan — good balance, deterministic.
//   4. Verify: every agent-pair of slices must classify `disjoint`.
//      Non-disjoint output is a planner bug -> exit 3 (fail-closed).
//
// Usage:
//   node scripts/collision-partition-propose.mjs --map repomap.json --agents 4 --scope docs/
//   node scripts/collision-partition-propose.mjs --scan . --agents 4 --scope docs/   (git ls-files, read-only)
//   repomap.json: [{ "path": "docs/a.md", "weight": 1 }]
// Exit: 0 proposal printed + verified disjoint; 3 verification failed; 1 usage/error.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { normalizePath, classifyPair } from './collision-path-normalize.mjs';

function buildTree(entries, scope) {
  // entries: [{ path, weight }]; returns node { name, path, weight, children: Map }
  const root = { name: '', path: scope || '', weight: 0, children: new Map() };
  for (const e of entries) {
    const n = normalizePath(e.path);
    if (!n || n.dir) continue; // map holds files only
    if (scope && !(n.path === scope || n.path.startsWith(scope + '/'))) continue;
    const rel = scope ? n.path.slice(scope.length + 1) : n.path;
    const segs = rel.split('/');
    let node = root;
    node.weight += e.weight ?? 1;
    for (let i = 0; i < segs.length; i++) {
      const last = i === segs.length - 1;
      const childPath = (scope ? scope + '/' : '') + segs.slice(0, i + 1).join('/');
      if (!node.children.has(segs[i])) {
        node.children.set(segs[i], {
          name: segs[i],
          path: childPath,
          weight: 0,
          children: new Map(),
          file: last,
        });
      }
      node = node.children.get(segs[i]);
      node.weight += e.weight ?? 1;
    }
  }
  return root;
}

function expand(root, n) {
  // Frontier of partition nodes. Split the heaviest splittable node while we
  // still need leaves (frontier < n) OR while the heaviest leaf outweighs the
  // ideal per-agent share (balance refinement). Cap total leaves at 16*n so a
  // giant flat directory degrades to bounded file-level slices, not an
  // explosion. The cap is generous (256*n): a flat dir of F files costs F
  // leaves, and LPT rebalances them across agents — disjointness is never
  // sacrificed for slice chunkiness. Deterministic: ties broken by path.
  const ideal = root.weight / n;
  const maxLeaves = Math.max(n, n * 256);
  let frontier = [root];
  for (;;) {
    const candidates = frontier
      .filter((node) => node.children.size > 0)
      .sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : 1));
    const heaviest = candidates[0];
    if (!heaviest) break; // nothing left to split
    const needMore = frontier.length < n;
    const tooHeavy = heaviest.weight > ideal && frontier.length < maxLeaves;
    if (!needMore && !tooHeavy) break;
    frontier = frontier.filter((node) => node !== heaviest);
    const kids = [...heaviest.children.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
    frontier.push(...kids);
  }
  return frontier;
}

function assignLpt(leaves, n) {
  const agents = Array.from({ length: n }, (_, i) => ({ agent: i, weight: 0, scopes: [] }));
  const sorted = [...leaves].sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : 1));
  for (const leaf of sorted) {
    let target = agents[0];
    for (const a of agents) if (a.weight < target.weight) target = a;
    target.weight += leaf.weight;
    // A leaf that is a directory becomes a dir scope (trailing slash); a
    // file leaf stays a file scope. Either way: disjoint from other leaves.
    target.scopes.push(leaf.children.size ? leaf.path + '/' : leaf.path);
  }
  // Drop empty agents (more agents than leaves) — reported, not hidden.
  return agents.filter((a) => a.scopes.length > 0);
}

function verifyDisjoint(agents) {
  const problems = [];
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const { verdict, evidence } = classifyPair(agents[i].scopes, agents[j].scopes);
      if (verdict !== 'disjoint') {
        problems.push({ a: agents[i].agent, b: agents[j].agent, verdict, evidence });
      }
    }
  }
  return problems;
}

function scanWithGit(dir, scope) {
  // Read-only: `git ls-files` never touches the worktree.
  const out = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((path) => ({ path, weight: 1 }));
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const agentsN = parseInt(get('--agents') ?? '', 10);
  let scope = (get('--scope') ?? '').trim();
  const mapFile = get('--map');
  const scanDir = get('--scan');
  if (!Number.isInteger(agentsN) || agentsN < 1 || args.includes('--help') || args.includes('-h')) {
    console.log(
      'usage: node scripts/collision-partition-propose.mjs --agents N [--scope docs/] (--map repomap.json | --scan <dir>)\n' +
        '  Prints a JSON partition proposal with a disjointness proof. Report-only.'
    );
    process.exit(1);
  }
  if (scope) {
    const n = normalizePath(scope);
    if (!n) {
      console.error(`bad --scope: ${scope}`);
      process.exit(1);
    }
    scope = n.path;
  }
  let entries;
  try {
    if (mapFile) entries = JSON.parse(readFileSync(mapFile, 'utf8'));
    else if (scanDir) entries = scanWithGit(scanDir, scope);
    else {
      console.error('need --map or --scan');
      process.exit(1);
    }
  } catch (e) {
    console.error(`input error: ${e.message}`);
    process.exit(1);
  }
  const root = buildTree(entries, scope);
  const leaves = expand(root, agentsN);
  const agents = assignLpt(leaves, agentsN);
  const problems = verifyDisjoint(agents);
  const totalWeight = agents.reduce((s, a) => s + a.weight, 0);
  const proposal = {
    scope: scope ? scope + '/' : '(repo root)',
    requestedAgents: agentsN,
    assignedAgents: agents.length,
    totalWeight,
    agents: agents.map((a) => ({
      agent: `partition-${String(a.agent).padStart(2, '0')}`,
      weight: a.weight,
      share: totalWeight ? +(a.weight / totalWeight).toFixed(4) : 0,
      scopes: a.scopes,
    })),
    verification: {
      pairsChecked: (agents.length * (agents.length - 1)) / 2,
      allDisjoint: problems.length === 0,
      problems,
    },
  };
  console.log(JSON.stringify(proposal, args.includes('--pretty') ? 2 : 0));
  if (problems.length) {
    console.error('FAIL-CLOSED: planner emitted overlapping slices (bug).');
    process.exit(3);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { buildTree, expand, assignLpt, verifyDisjoint };
