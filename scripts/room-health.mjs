#!/usr/bin/env node
/**
 * room-health.mjs — Room health dashboard generator (OBS-1).
 *
 * Fetches LIVE data and writes a self-contained static page:
 *   docs/room-health.html
 *
 * Panels:
 *   1. Open claims by lane        (parsed the way scripts/room does, via
 *                                  scripts/room _parse | _state)
 *   2. PR age distribution        (open PRs bucketed by age; stale flagged)
 *   3. Hosted CI health           (statusCheckRollup pass/fail rates over
 *                                  open PRs; currently-failing PRs listed)
 *   4. Board comment count vs the 2500 cap, with a simple projection
 *   5. Upcoming lease expirations  (leases expiring within the next 24h)
 *
 * Read-only against the board: never posts. Run on demand or from cron:
 *
 *   TMPDIR=<wt>/.tmp node scripts/room-health.mjs [--out <path>]
 *
 * The page bakes in the fetched data at generation time; the "generated at"
 * timestamp in the page header says when. No placeholders: every panel
 * renders fetched numbers or an explicit "(none / fetch failed)" state.
 *
 * Exit 0 with a written page. Exit 2 if the page could not be written.
 * Data-source failures are surfaced IN the page, not fatal: the dashboard
 * is allowed to degrade per panel (see `panelError`).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const ROOM_SH = resolve(REPO, 'scripts/room');
const REPO_SLUG = 'Uuriko/project-room';
const BOARD_ISSUE = 266;
const COMMENT_CAP = 2500;
const STALE_PR_DAYS = 7;
const AGING_PR_DAYS = 3;

const argv = process.argv.slice(2);
function flag(name, def = null) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}
const OUT = resolve(REPO, flag('--out', 'docs/room-health.html'));

function sh(cmd, args, input) {
  try {
    const out = execFileSync(cmd, args, {
      input,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      cwd: REPO,
      timeout: 300_000,
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e).slice(0, 400) };
  }
}

// ---------------------------------------------------------------- fetchers

function fetchComments() {
  // Raw comment JSON array (id, created_at, body) — the exact input that
  // scripts/room's parse_events consumes. --paginate emits one array per
  // page, so merge them with jq -s first.
  const r = sh('gh', [
    'api',
    `repos/${REPO_SLUG}/issues/${BOARD_ISSUE}/comments`,
    '--paginate',
  ]);
  if (!r.ok) return r;
  const merged = sh('jq', ['-s', 'add | map({id, created_at, body})'], r.out);
  if (!merged.ok) return { ok: false, err: 'comment merge: ' + merged.err };
  try {
    return { ok: true, out: JSON.parse(merged.out) };
  } catch (e) {
    return { ok: false, err: 'comment JSON parse: ' + String(e).slice(0, 200) };
  }
}

function boardState(comments) {
  // Reuse the room's own machine parser — same validation as every lane.
  const raw = JSON.stringify(comments);
  const ev = sh('bash', [ROOM_SH, '_parse'], raw);
  if (!ev.ok) return { ok: false, err: 'room _parse: ' + ev.err };
  const st = sh('bash', [ROOM_SH, '_state'], ev.out);
  if (!st.ok) return { ok: false, err: 'room _state: ' + st.err };
  try {
    return { ok: true, out: JSON.parse(st.out) };
  } catch (e) {
    return { ok: false, err: 'state JSON parse: ' + String(e).slice(0, 200) };
  }
}

function fetchIssueMeta() {
  const r = sh('gh', [
    'api',
    `repos/${REPO_SLUG}/issues/${BOARD_ISSUE}`,
    '--jq',
    '{comments: .comments, state: .state, updated_at: .updated_at}',
  ]);
  if (!r.ok) return r;
  try {
    return { ok: true, out: JSON.parse(r.out) };
  } catch (e) {
    return { ok: false, err: 'issue JSON parse: ' + String(e).slice(0, 200) };
  }
}

function fetchOpenPRs() {
  const r = sh('gh', [
    'pr',
    'list',
    '--repo',
    REPO_SLUG,
    '--state',
    'open',
    '--limit',
    '200',
    '--json',
    'number,title,createdAt,headRefName,author,statusCheckRollup',
  ]);
  if (!r.ok) return r;
  try {
    return { ok: true, out: JSON.parse(r.out) };
  } catch (e) {
    return { ok: false, err: 'PR JSON parse: ' + String(e).slice(0, 200) };
  }
}

// ------------------------------------------------------------------ panels

const LIVE = new Set(['submitted', 'working', 'suspended']);
const nowMs = () => Date.now();

function claimsPanel(state) {
  const tasks = Object.values((state && state.tasks) || {});
  const live = tasks.filter((t) => LIVE.has(String(t.state || '').split('(')[0]));
  const byLane = new Map();
  for (const t of live) {
    const lane = t.lane || '(unclaimed)';
    if (!byLane.has(lane)) byLane.set(lane, []);
    byLane.get(lane).push(t);
  }
  const lanes = [...byLane.entries()]
    .map(([lane, ts]) => ({
      lane,
      count: ts.length,
      claims: ts
        .map((t) => ({
          task_id: t.task_id,
          state: t.state,
          expires: t.lease_expires_at || null,
          files: (t.files || []).join(', '),
        }))
        .sort((a, b) => String(a.task_id).localeCompare(String(b.task_id))),
    }))
    .sort((a, b) => b.count - a.count || a.lane.localeCompare(b.lane));
  return { live: live.length, lanes };
}

function prAgePanel(prs, now) {
  const buckets = [
    { key: '< 1 day', min: 0, max: 1, prs: [] },
    { key: '1–3 days', min: 1, max: 3, prs: [] },
    { key: '3–7 days', min: 3, max: 7, prs: [] },
    { key: '> 7 days (stale)', min: 7, max: Infinity, prs: [] },
  ];
  const stale = [];
  for (const pr of prs) {
    const ageDays = (now - Date.parse(pr.createdAt)) / 86_400_000;
    const row = {
      number: pr.number,
      title: pr.title,
      author: (pr.author && pr.author.login) || '?',
      ageDays: Math.round(ageDays * 10) / 10,
      branch: pr.headRefName,
    };
    const b = buckets.find((x) => ageDays >= x.min && ageDays < x.max);
    (b || buckets[buckets.length - 1]).prs.push(row);
    if (ageDays > STALE_PR_DAYS) stale.push(row);
  }
  for (const b of buckets) b.prs.sort((a, c) => c.ageDays - a.ageDays);
  stale.sort((a, c) => c.ageDays - a.ageDays);
  return { total: prs.length, buckets: buckets.map(({ key, prs: p }) => ({ key, count: p.length })), stale };
}

/**
 * CI panel data over open PRs' statusCheckRollup rows (pure; exported for
 * tests). Rows may be CheckRun {status, conclusion} or legacy StatusContext
 * {state, context} shapes — see L-52.
 */
export function ciPanel(prs) {
  let pass = 0;
  let fail = 0;
  let pending = 0;
  let none = 0;
  const failing = [];
  // statusCheckRollup rows are a union: CheckRun {status, conclusion} or a
  // legacy StatusContext {state, context} from the old Statuses API. Branch
  // on __typename/state rather than assuming CheckRun shape (L-52).
  const checkState = (c) => {
    if (c.__typename === 'StatusContext' || (c.state !== undefined && c.status === undefined)) {
      const done = c.state !== 'PENDING';
      return { done, ok: !done || c.state === 'SUCCESS' };
    }
    const done = c.status === 'COMPLETED';
    const ok = !done || c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' || c.conclusion === 'SKIPPED';
    return { done, ok };
  };
  for (const pr of prs) {
    const rollup = pr.statusCheckRollup || [];
    const states = rollup.map(checkState);
    const done = states.filter((s) => s.done);
    const inFlight = states.length - done.length;
    const failed = done.filter((s) => !s.ok);
    if (rollup.length === 0) {
      none += 1;
    } else if (failed.length > 0) {
      fail += 1;
      failing.push({ number: pr.number, title: pr.title, failed: failed.length, total: rollup.length });
    } else if (inFlight > 0) {
      pending += 1;
    } else {
      pass += 1;
    }
  }
  failing.sort((a, b) => a.number - b.number);
  const withCI = prs.length - none;
  return {
    total: prs.length,
    pass,
    fail,
    pending,
    none,
    failing,
    passRate: withCI ? Math.round((pass / withCI) * 1000) / 10 : null,
  };
}

function boardPressurePanel(issueMeta, comments) {
  const count = issueMeta && typeof issueMeta.comments === 'number' ? issueMeta.comments : null;
  if (count === null) return { count: null };
  // Simple projection: comments in the trailing 24h -> rate -> days to cap.
  let rate24h = null;
  let projectedDays = null;
  if (Array.isArray(comments)) {
    const cutoff = Date.now() - 24 * 3600_000;
    const recent = comments.filter((c) => Date.parse(c.created_at) >= cutoff).length;
    rate24h = recent;
    if (recent > 0) projectedDays = Math.round(((COMMENT_CAP - count) / recent) * 10) / 10;
  }
  return {
    count,
    cap: COMMENT_CAP,
    pct: Math.round((count / COMMENT_CAP) * 1000) / 10,
    remaining: COMMENT_CAP - count,
    rate24h,
    projectedDays,
    // sparse daily series (one point per day, last 14d) for the projection line
    series: Array.isArray(comments) ? dailySeries(comments, 14) : [],
  };
}

function dailySeries(comments, days) {
  const dayMs = 86_400_000;
  const end = Date.now();
  const out = [];
  for (let d = days; d >= 1; d--) {
    const from = end - d * dayMs;
    const to = end - (d - 1) * dayMs;
    const n = comments.filter((c) => {
      const t = Date.parse(c.created_at);
      return t >= from && t < to;
    }).length;
    out.push({ day: new Date(to).toISOString().slice(0, 10), count: n });
  }
  return out;
}

function leasesPanel(state, now) {
  const tasks = Object.values((state && state.tasks) || {});
  const soon = [];
  for (const t of tasks) {
    if (!LIVE.has(String(t.state || '').split('(')[0])) continue;
    if (!t.lease_expires_at) continue;
    const expMs = Date.parse(t.lease_expires_at);
    if (Number.isNaN(expMs)) continue;
    const inH = (expMs - now) / 3600_000;
    if (inH <= 24) {
      soon.push({
        task_id: t.task_id,
        lane: t.lane || '(unclaimed)',
        state: t.state,
        expires: t.lease_expires_at,
        inHours: Math.round(inH * 10) / 10,
        expired: inH < 0,
      });
    }
  }
  soon.sort((a, b) => a.inHours - b.inHours);
  return { total: soon.length, claims: soon };
}

// ------------------------------------------------------------------- render

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function panel(title, inner, note) {
  return `<section class="panel"><h2>${esc(title)}</h2>${note ? `<p class="note">${esc(note)}</p>` : ''}${inner}</section>`;
}

function errPanel(title, err) {
  return `<section class="panel error"><h2>${esc(title)}</h2><p class="err">fetch failed: ${esc(err)}</p></section>`;
}

function render(data) {
  const { generatedAt, claims, prAge, ci, pressure, leases, errors } = data;

  // 1. claims by lane
  const p1 =
    claims && !errors.claims
      ? panel(
          '1 · Open claims by lane',
          `<table><tr><th>lane</th><th>open</th><th>claims</th></tr>` +
            claims.lanes
              .map(
                (l) =>
                  `<tr><td class="lane">${esc(l.lane)}</td><td class="num">${l.count}</td>` +
                  `<td>${l.claims.map((c) => `<span class="chip" title="${esc(c.files)} · expires ${esc(c.expires || 'n/a')}">${esc(c.task_id)} · ${esc(c.state)}</span>`).join(' ') || '<span class="dim">—</span>'}</td></tr>`,
              )
              .join('') +
            `</table><p class="note">${claims.live} live claims total</p>`,
        )
      : errPanel('1 · Open claims by lane', errors.claims);

  // 2. PR age
  const p2 =
    prAge && !errors.prs
      ? panel(
          '2 · PR age distribution',
          `<div class="bars">` +
            prAge.buckets
              .map((b) => {
                const w = prAge.total ? Math.round((b.count / prAge.total) * 100) : 0;
                const cls = b.key.includes('stale') ? 'bar stale' : 'bar';
                return `<div class="brow"><span class="blabel">${esc(b.key)}</span><span class="${cls}" style="width:${Math.max(w, 2)}%"></span><span class="bnum">${b.count}</span></div>`;
              })
              .join('') +
            `</div>` +
            (prAge.stale.length
              ? `<p class="warn">⚠ stale (&gt;${STALE_PR_DAYS}d open): ` +
                prAge.stale.map((p) => `<span class="chip">#${p.number} ${esc(p.ageDays)}d — ${esc(p.title.slice(0, 60))}</span>`).join(' ') +
                `</p>`
              : `<p class="ok">no stale PRs (&gt;${STALE_PR_DAYS}d) — open PRs: ${prAge.total}</p>`),
          `stale = open longer than ${STALE_PR_DAYS} days; aging = ${AGING_PR_DAYS}–${STALE_PR_DAYS} days`,
        )
      : errPanel('2 · PR age distribution', errors.prs);

  // 3. CI health
  const p3 =
    ci && !errors.prs
      ? panel(
          '3 · Hosted CI health (open PRs)',
          `<div class="statgrid">` +
            `<div class="stat good"><span class="sv">${ci.pass}</span><span class="sl">passing</span></div>` +
            `<div class="stat bad"><span class="sv">${ci.fail}</span><span class="sl">failing</span></div>` +
            `<div class="stat pend"><span class="sv">${ci.pending}</span><span class="sl">in flight</span></div>` +
            `<div class="stat dim"><span class="sv">${ci.none}</span><span class="sl">no checks</span></div>` +
            `</div>` +
            `<p class="note">${ci.passRate === null ? 'no PRs carry checks' : `pass rate ${ci.passRate}% of PRs with checks`} · ${ci.total} open PRs</p>` +
            (ci.failing.length
              ? `<p class="warn">⚠ currently failing: ` +
                ci.failing.map((f) => `<span class="chip">#${f.number} ${f.failed}/${f.total} checks — ${esc(f.title.slice(0, 50))}</span>`).join(' ') +
                `</p>`
              : `<p class="ok">no open PR has a failing check</p>`),
        )
      : errPanel('3 · Hosted CI health', errors.prs);

  // 4. board pressure
  const p4 =
    pressure && !errors.pressure
      ? panel(
          '4 · Board pressure (#266)',
          `<div class="brow"><span class="blabel">${pressure.count} / ${pressure.cap}</span><span class="bar cap" style="width:${Math.min(pressure.pct, 100)}%"></span><span class="bnum">${pressure.pct}%</span></div>` +
            `<div class="brow proj"><span class="blabel">projection (24h rate)</span><span class="bval">${pressure.rate24h === null ? '—' : `${pressure.rate24h} comments/day → cap in ≈${pressure.projectedDays === null ? '∞' : pressure.projectedDays + ' days'}`}</span></div>` +
            (pressure.series.length
              ? `<svg class="spark" viewBox="0 0 280 60" preserveAspectRatio="none" aria-label="comments per day, last 14 days">` +
                pressure.series
                  .map((d, i) => {
                    const max = Math.max(...pressure.series.map((x) => x.count), 1);
                    const h = Math.max(2, (d.count / max) * 56);
                    const x = (i / Math.max(pressure.series.length - 1, 1)) * 276;
                    return `<rect x="${x.toFixed(1)}" y="${(58 - h).toFixed(1)}" width="14" height="${h.toFixed(1)}" fill="#7aa2f7"><title>${d.day}: ${d.count}/day</title></rect>`;
                  })
                  .join('') +
                `</svg><p class="note">comments/day, trailing 14 days</p>`
              : ''),
          `${pressure.remaining} comments of headroom before the 2500-comment GitHub limit; projection assumes the trailing-24h rate holds`,
        )
      : errPanel('4 · Board pressure', errors.pressure);

  // 5. lease expirations
  const p5 =
    leases && !errors.claims
      ? panel(
          '5 · Upcoming lease expirations (≤24h)',
          leases.claims.length
            ? `<table><tr><th>task-id</th><th>lane</th><th>state</th><th>expires in</th><th>at (UTC)</th></tr>` +
              leases.claims
                .map(
                  (c) =>
                    `<tr${c.expired ? ' class="expired"' : ''}><td class="mono">${esc(c.task_id)}</td><td class="lane">${esc(c.lane)}</td><td>${esc(c.state)}</td>` +
                    `<td class="num">${c.expired ? 'EXPIRED ' : ''}${esc(c.inHours)}h</td><td class="mono">${esc(c.expires)}</td></tr>`,
                )
                .join('') + `</table>`
            : `<p class="ok">no live claim expires within the next 24h</p>`,
        )
      : errPanel('5 · Upcoming lease expirations', errors.claims);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Room health — Uuriko/project-room</title>
<style>
:root{color-scheme:light dark}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:1080px;margin:0 auto;padding:24px;background:#f7f7f5;color:#1a1a1a}
@media(prefers-color-scheme:dark){body{background:#141412;color:#e8e6e0}}
h1{font-size:1.6rem;margin:0 0 4px}
.sub{color:#666;margin:0 0 20px;font-size:.9rem}
@media(prefers-color-scheme:dark){.sub{color:#aaa}}
.panel{background:#fff;border:1px solid #e2e2de;border-radius:10px;padding:16px 18px;margin:0 0 16px}
@media(prefers-color-scheme:dark){.panel{background:#1d1d1a;border-color:#333}}
.panel h2{font-size:1.05rem;margin:0 0 10px}
.panel.error{border-color:#d66}
.err{color:#a33;font-family:monospace;font-size:.85rem}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{text-align:left;border-bottom:2px solid #ddd;padding:4px 6px}
td{border-bottom:1px solid #eee;padding:4px 6px;vertical-align:top}
@media(prefers-color-scheme:dark){th{border-color:#444}td{border-color:#2a2a2a}}
.num{text-align:right;font-variant-numeric:tabular-nums}
.mono{font-family:ui-monospace,monospace;font-size:.8rem}
.lane{font-weight:600}
.chip{display:inline-block;background:#eef2ff;border:1px solid #c9d4ff;border-radius:999px;padding:1px 8px;margin:1px 2px;font-size:.75rem;font-family:ui-monospace,monospace;white-space:nowrap}
@media(prefers-color-scheme:dark){.chip{background:#24304d;border-color:#3a4a75}}
.note{font-size:.8rem;color:#666;margin:10px 0 0}
@media(prefers-color-scheme:dark){.note{color:#aaa}}
.warn{font-size:.85rem;background:#fff7e6;border:1px solid #f0d9a0;border-radius:6px;padding:8px 10px}
.ok{font-size:.85rem;color:#2a7a2a}
.dim{color:#999}
.brow{display:flex;align-items:center;gap:10px;margin:6px 0;font-size:.85rem}
.blabel{width:150px;flex:none}
.bar{display:inline-block;height:14px;background:#7aa2f7;border-radius:3px;min-width:4px}
.bar.stale{background:#e06666}
.bar.cap{background:linear-gradient(90deg,#7aa2f7,#5b8def)}
.bnum{font-variant-numeric:tabular-nums;font-weight:600}
.bval{font-size:.85rem}
.statgrid{display:flex;gap:12px;flex-wrap:wrap}
.stat{border:1px solid #e2e2de;border-radius:8px;padding:10px 16px;min-width:100px;text-align:center}
.stat .sv{display:block;font-size:1.6rem;font-weight:700;font-variant-numeric:tabular-nums}
.stat .sl{font-size:.75rem;color:#666}
.stat.good .sv{color:#2a7a2a}.stat.bad .sv{color:#c0392b}.stat.pend .sv{color:#b8860b}
.spark{width:100%;max-width:420px;height:60px;margin-top:8px}
.expired td{background:#fdeaea}
@media(prefers-color-scheme:dark){.expired td{background:#3a2222}}
</style></head>
<body>
<h1>🪔 Room health — Uuriko/project-room</h1>
<p class="sub">generated ${esc(generatedAt)} · live data from GitHub (no snapshots) · regenerate: <code>TMPDIR=&lt;wt&gt;/.tmp node scripts/room-health.mjs</code></p>
${p1}${p2}${p3}${p4}${p5}
<footer class="sub">OBS-1 · generator <code>scripts/room-health.mjs</code> · board #266 · cap ${COMMENT_CAP}</footer>
</body></html>`;
}

// -------------------------------------------------------------------- main

function main() {
  const errors = {};
  const now = nowMs();
  const generatedAt = new Date(now).toISOString();

  const c = fetchComments();
  let comments = null;
  let state = null;
  if (!c.ok) {
    errors.claims = 'comments: ' + c.err;
    errors.pressure = 'comments: ' + c.err;
  } else {
    comments = c.out;
    const s = boardState(comments);
    if (!s.ok) errors.claims = s.err;
    else state = s.out;
  }

  const meta = fetchIssueMeta();
  if (!meta.ok) errors.pressure = errors.pressure ? errors.pressure + '; meta: ' + meta.err : 'meta: ' + meta.err;

  const pr = fetchOpenPRs();
  let prs = null;
  if (!pr.ok) errors.prs = pr.err;
  else prs = pr.out;

  const data = {
    generatedAt,
    claims: state ? claimsPanel(state, now) : null,
    prAge: prs ? prAgePanel(prs, now) : null,
    ci: prs ? ciPanel(prs) : null,
    pressure: !errors.pressure && meta.ok ? boardPressurePanel(meta.out, comments) : null,
    leases: state ? leasesPanel(state, now) : null,
    errors,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  const html = render(data);
  writeFileSync(OUT, html, 'utf8');

  // machine summary to stdout (proof the page holds real data)
  const summary = {
    out: OUT,
    generatedAt,
    claimsLive: data.claims ? data.claims.live : null,
    lanes: data.claims ? data.claims.lanes.map((l) => `${l.lane}:${l.count}`) : null,
    openPRs: data.prAge ? data.prAge.total : null,
    prBuckets: data.prAge ? data.prAge.buckets : null,
    stalePRs: data.prAge ? data.prAge.stale.map((p) => `#${p.number} (${p.ageDays}d)`) : null,
    ci: data.ci ? { pass: data.ci.pass, fail: data.ci.fail, pending: data.ci.pending, none: data.ci.none, failing: data.ci.failing.map((f) => '#' + f.number) } : null,
    boardComments: data.pressure ? `${data.pressure.count}/${data.pressure.cap}` : null,
    projectedDaysToCap: data.pressure ? data.pressure.projectedDays : null,
    leasesExpiring24h: data.leases ? data.leases.claims.map((x) => `${x.task_id} ${x.inHours}h`) : null,
    errors,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (Object.keys(errors).length) process.exitCode = 1;
}

// Importable for tests (ciPanel is exported): only run the report when this
// file is executed directly, never as a library import.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
