// Project Room speed bench. Usage:
//   node perf/speed-bench.mjs local [--repo .] [--seed 2000] [--n 20] [--rtt 0]   (disposable loopback fixture)
//   node perf/speed-bench.mjs pages                                                         (public pages: Room prod, Slack, Linear; read-only, no sign-in)
// Output: JSON to stdout and results/<mode>-<label>-<ts>.json. Never prints secrets.
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2); const mode = args[0] || 'local';
const opt = (k, d) => { const i = args.indexOf('--' + k); return i > 0 ? args[i + 1] : d; };
const REPO = resolve(opt('repo', '.')); const SEED = +opt('seed', 2000); const N = +opt('n', 20); const RTT = +opt('rtt', 0);
const LABEL = opt('label', (mode === 'local' ? REPO.split('/').pop() : 'public') + (RTT ? '-rtt' + RTT : ''));
const { chromium } = await import(join(mode === 'local' ? REPO : here, 'node_modules/playwright-core/index.mjs')).catch(() => import(join(REPO, 'node_modules/playwright/index.mjs')));
const exe = process.env.CHROME || undefined;
const stat = a => { const s = [...a].sort((x, y) => x - y); const q = p => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); return { p50: q(0.5), p95: q(0.95), n: s.length }; };
const now = () => performance.now();

async function pageMetrics(ctx, url, readySelector) {
  const page = await ctx.newPage(); if (RTT) { const c = await ctx.newCDPSession(page); await c.send('Network.enable'); await c.send('Network.emulateNetworkConditions', { offline: false, latency: RTT, downloadThroughput: 20e6 / 8, uploadThroughput: 5e6 / 8 }); } let js = 0, css = 0, reqs = 0, total = 0;
  page.on('response', async r => { reqs++; const len = +(r.headers()['content-length'] || 0); let b = len; if (!len) { try { b = (await r.body()).length; } catch {} } total += b; const t = r.request().resourceType(); if (t === 'script') js += b; if (t === 'stylesheet') css += b; });
  await page.addInitScript(() => { window.__lcp = 0; new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); });
  const t0 = now(); await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  let ready = null; if (readySelector) { await page.locator(readySelector).first().waitFor({ timeout: 30000 }); ready = +(now() - t0).toFixed(0); }
  await page.waitForTimeout(1500);
  const m = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; const fcp = performance.getEntriesByName('first-contentful-paint')[0]; return { ttfb: Math.round(n.responseStart), fcp: Math.round(fcp?.startTime || 0), lcp: Math.round(window.__lcp), domInteractive: Math.round(n.domInteractive), load: Math.round(n.loadEventEnd), domNodes: document.getElementsByTagName('*').length }; });
  return { page, m: { ...m, readyMs: ready, jsKB: Math.round(js / 1024), cssKB: Math.round(css / 1024), totalKB: Math.round(total / 1024), requests: reqs } };
}

if (mode === 'pages') {
  const targets = [
    ['room-home', 'https://room.trydemigod.com/'], ['room-room-shell', 'https://room.trydemigod.com/room/'],
    ['slack-home', 'https://slack.com/'], ['slack-signin', 'https://app.slack.com/'],
    ['linear-home', 'https://linear.app/'], ['linear-login', 'https://linear.app/login'],
    ['discord-login', 'https://discord.com/login'],
  ];
  const browser = await chromium.launch({ executablePath: exe, headless: true }); const out = {};
  for (const [k, u] of targets) {
    try { const ctx = await browser.newContext(); const cold = await pageMetrics(ctx, u); await cold.page.close();
      const warm = await pageMetrics(ctx, u); await warm.page.close(); await ctx.close(); out[k] = { url: u, cold: cold.m, warm: warm.m };
    } catch (e) { out[k] = { url: u, error: String(e.message).slice(0, 160) }; }
  }
  await browser.close(); save(out);
} else {
  const { createAcceptanceFixture } = await import(join(REPO, 'scripts/acceptance-fixture.mjs'));
  const { createRoomServer } = await import(join(REPO, 'server/http.mjs'));
  const { signInFixture } = await import(join(REPO, 'scripts/auth-signin.mjs'));
  const f = createAcceptanceFixture(); f.store.roomFlood = { consume() {} };
  const tSeed = now();
  for (let i = 0; i < SEED; i++) f.store.command(f.keys.owner, 'commons', { id: 'seed-' + i, type: 'message.posted', data: { messageId: 'seed-m' + i, body: `Seed message ${i} about deploys, search tokens and the board ${i % 7}` } });
  const seedMs = now() - tSeed;
  const server = createRoomServer({ store: f.store, streamInterval: 30 });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const O = `http://127.0.0.1:${server.address().port}`;
  const H = { Authorization: `Bearer ${f.keys.owner}`, 'Content-Type': 'application/json' };
  const timeGet = async p => { const a = []; let bytes = 0, status = 0; for (let i = 0; i < N; i++) { const t = now(); const r = await fetch(O + p, { headers: H }); const b = await r.arrayBuffer(); a.push(now() - t); bytes = b.byteLength; status = r.status; } return { ...stat(a), KB: Math.round(bytes / 1024), status }; };
  const api = {
    snapshot: await timeGet('/api/rooms/commons'),
    events_latest50: await timeGet('/api/rooms/commons/events?limit=50'),
    tail1: await timeGet('/api/rooms/commons/events?after=0&limit=1'),
    search: await timeGet('/api/rooms/commons/search?q=deploys'),
  };
  // send -> visible over SSE (API): post, wait for messageId on /stream
  const ctl = new AbortController(); const sr = await fetch(O + '/api/rooms/commons/stream', { headers: { Authorization: H.Authorization, Accept: 'text/event-stream' }, signal: ctl.signal });
  const reader = sr.body.getReader(); const dec = new TextDecoder(); let buf = ''; const waiters = new Map();
  (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); for (const [id, res] of waiters) if (buf.includes(id)) { waiters.delete(id); res(); } if (buf.length > 2e6) buf = buf.slice(-1e5); } } catch {} })();
  const sse = [], post = [];
  for (let i = 0; i < N; i++) { const id = 'bench-' + i + '-' + Date.now(); const seen = new Promise(r => waiters.set(id, r)); const t = now();
    const r = await fetch(O + '/api/rooms/commons/commands', { method: 'POST', headers: H, body: JSON.stringify({ id, type: 'message.posted', data: { messageId: id, body: 'bench ' + i } }) }); await r.arrayBuffer(); post.push(now() - t);
    await Promise.race([seen, new Promise(r => setTimeout(r, 5000))]); sse.push(now() - t); }
  ctl.abort(); api.post_ack = stat(post); api.send_to_sse_visible = stat(sse);
  // browser
  const browser = await chromium.launch({ executablePath: exe, headless: true }); const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p0 = await ctx.newPage(); p0.on('pageerror', e => console.error('PAGEERR', String(e.message).slice(0,300))); p0.on('requestfailed', r => console.error('FAILED', r.failure()?.errorText, new URL(r.url()).pathname)); p0.on('console', m => { if (m.type()==='error') console.error('CONSOLE', m.text().slice(0,200)); }); p0.on('response', r => { if (r.status()>=400) console.error('HTTP', r.status(), new URL(r.url()).pathname); }); await p0.goto(O); try { await signInFixture(p0, f.keys.owner); } catch (e) { await p0.screenshot({ path: join(here, 'signin-fail.png') }); console.error('URL', p0.url(), (await p0.locator('body').innerText()).slice(0, 600)); throw e; } await p0.locator('[data-message-record-id]').first().waitFor({ timeout: 30000 }); await p0.close();
  const sel = '[data-message-record-id]';
  // cold: fresh context with cookies only (empty HTTP cache)
  const state = await ctx.storageState(); const coldCtx = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 800 } });
  const cold = await pageMetrics(coldCtx, O + '/', sel); await cold.page.close();
  const warm = await pageMetrics(coldCtx, O + '/', sel);
  const ui = [];
  for (let i = 0; i < Math.min(N, 10); i++) { const txt = 'ui-send-' + i + '-' + Date.now(); await warm.page.locator('#message-input').fill(txt); const t = now(); await warm.page.locator('#message-input').press('Enter'); await warm.page.getByText(txt).first().waitFor({ timeout: 10000 }); ui.push(now() - t); }
  await browser.close(); server.closeStreams?.(); server.closeAllConnections?.(); await new Promise(r => server.close(r)); f.store.close?.(); try { rmSync(f.directory, { recursive: true, force: true }); } catch {}
  save({ repo: REPO, rttMs: RTT, network: RTT ? '20 Mbps down / 5 up' : 'loopback', seed: SEED, seedMsPerWrite: +(seedMs / SEED).toFixed(2), api, browser: { cold: cold.m, warm: warm.m, ui_send_to_visible: stat(ui) } });
}
function save(o) { mkdirSync(join(here, 'results'), { recursive: true }); const p = join(here, 'results', `${mode}-${LABEL}-${Date.now()}.json`); writeFileSync(p, JSON.stringify(o, null, 1)); console.log(JSON.stringify(o, null, 1)); console.error('saved', p); process.exit(0); }
