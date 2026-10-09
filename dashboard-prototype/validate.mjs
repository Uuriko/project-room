#!/usr/bin/env node
// validate.mjs — sanity checks for the dashboard prototype. Exit 0 = pass.
// Checks: fixtures parse, schema shape, embedded copies in index.html match
// the fixture files, and the inline page script has no syntax errors.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const dir = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const read = (p) => readFileSync(join(dir, p), 'utf8');

// 1. fixtures parse
let agents, claims, events;
try { agents = JSON.parse(read('fixtures/agents.json')); check('agents.json parses', true); }
catch (e) { check('agents.json parses', false, e.message); }
try { claims = JSON.parse(read('fixtures/claims-board.json')); check('claims-board.json parses', true); }
catch (e) { check('claims-board.json parses', false, e.message); }
try { events = JSON.parse(read('fixtures/events.json')); check('events.json parses', true); }
catch (e) { check('events.json parses', false, e.message); }

// 2. schema shape
check('agents rows', Array.isArray(agents?.agents) && agents.agents.length > 0 &&
  agents.agents.every(a => a.name && a.lane && a.status), `${agents?.agents?.length ?? 0} agents`);
check('claims totals consistent', (() => {
  if (!claims) return false;
  const s = claims.totals;
  return s.total === s.submitted + s.working + s.completed + s.cancelled + s.expired &&
    s.open === s.submitted + s.working &&
    claims.claims.length === s.total;
})(), `${claims?.totals?.total ?? 0} claims`);
check('events buckets', Array.isArray(events?.buckets) && events.buckets.length === 96 &&
  events.buckets.every(b => typeof b.eventsPerMin === 'number'), `${events?.buckets?.length ?? 0} buckets`);
check('fixture notice present', [agents, claims, events].every(f => /SYNTHETIC/i.test(f?.notice || '')));

// 3. embedded copies in index.html match fixture files
const html = read('index.html');
for (const [id, obj] of [['fx-agents', agents], ['fx-claims', claims], ['fx-events', events]]) {
  const m = html.match(new RegExp(`<script type="application/json" id="${id}">(.*?)</script>`, 's'));
  const embedded = m && m[1];
  check(`index.html embeds ${id}`, !!embedded && embedded === JSON.stringify(obj),
    embedded === JSON.stringify(obj) ? '' : 'mismatch — rebuild index.html after regenerating fixtures');
}

// 4. inline page script has no syntax errors
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
check('exactly one inline page script', scripts.length === 1, `${scripts.length} found`);
try {
  writeFileSync('/tmp/guild27-check.js', scripts[0]);
  execFileSync(process.execPath, ['--check', '/tmp/guild27-check.js'], { stdio: 'pipe' });
  check('inline script syntax OK', true);
} catch (e) { check('inline script syntax OK', false, e.message); }

// 5. headless DOM smoke test: run the inline page script against a stubbed DOM
// and assert every section renders (catches JS runtime errors the syntax check misses).
try {
  const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const fx = {};
  for (const id of ['fx-agents', 'fx-claims', 'fx-events'])
    fx[id] = html.match(new RegExp(`<script type="application/json" id="${id}">(.*?)</script>`, 's'))[1];
  const noopCtx = new Proxy({}, { get: (t, k) => (k === 'canvas' ? {} : () => {}), set: () => true });
  const els = {};
  const mkEl = (id) => ({
    textContent: fx[id] || '', className: '', innerHTML: '',
    clientWidth: 1200, clientHeight: 300,
    getContext: () => noopCtx, addEventListener: () => {},
    querySelector: () => mkEl(id + '.q'),
  });
  const sandbox = {
    document: { getElementById: (id) => els[id] || (els[id] = mkEl(id)),
      querySelector: (sel) => els[sel] || (els[sel] = mkEl(sel)), documentElement: {} },
    window: { devicePixelRatio: 1 },
    getComputedStyle: () => ({ getPropertyValue: () => '#888' }),
  };
  const { runInNewContext } = await import('node:vm');
  runInNewContext(src, sandbox);
  const cnt = (key, pat) => (els[key].innerHTML.match(pat) || []).length;
  check('smoke: health pill', /HEALTH: (OK|WATCH|ACTION NEEDED)/.test(els['health-pill'].textContent));
  check('smoke: 4 KPI cards', cnt('kpis', /class="kpi"/g) === 4);
  check('smoke: lanes rows', cnt('#tbl-lanes tbody', /<tr>/g) === claims.byLane.length, `${claims.byLane.length} lanes`);
  check('smoke: claims rows', cnt('#tbl-claims tbody', /<tr>/g) === claims.claims.length, `${claims.claims.length} claims`);
  check('smoke: agent rows', cnt('#tbl-agents tbody', /<tr>/g) === agents.agents.length, `${agents.agents.length} agents`);
} catch (e) { check('smoke: page script runs', false, e.message); }

process.exit(failures ? 1 : 0);
