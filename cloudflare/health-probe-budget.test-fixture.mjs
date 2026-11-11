import { DurableObject } from 'cloudflare:workers';
import worker, { ProjectRoom } from './room.mjs';

const observations = [];
let failTelemetry = false;
const originalInfo = console.info.bind(console);
console.info = (...args) => {
  let row;
  try { row = JSON.parse(args[0]); } catch { /* unrelated existing log */ }
  if (row?.event === 'room.readiness_probe') {
    if (failTelemetry) throw new Error('PRIVATE_TELEMETRY_FAILURE');
    observations.push(row);
    return;
  }
  originalInfo(...args);
};
export class BudgetProbe extends DurableObject {
  calls = 0;
  config = {};
  configure(config) { this.config = config; }
  count() { return this.calls; }
  fetch() { this.calls++; throw new Error('Unexpected Durable Object fetch forwarding'); }
  async result() {
    this.calls++;
    const config = this.config;
    if (config.stalled) {
      // A held RPC has no completion until the test explicitly releases it.
      // Keep I/O pending as a real blocked storage/network operation would.
      const keepAlive = setInterval(() => {}, 1000);
      try { await new Promise(resolve => { this.release = resolve; }); }
      finally { clearInterval(keepAlive); }
    } else await new Promise(resolve => setTimeout(resolve, config.delay ?? 0));
    if (config.error) throw new Error('fixture RPC failure');
    return config;
  }
  async probeStorage(request) {
    const config = await this.result(), result = { ok: config.ok !== false, emailVerification: 'enforced' };
    if (request === 'readiness-observation-v1' && config.observationPeer === 'valid') result.readinessObservation = {sourceRevision:'b'.repeat(40),buildId:'2026-11-01T12:01:00.000Z',sqlOutcome:'ok',sqlElapsedMs:1,doElapsedMs:3};
    if (config.observationPeer === 'supplied') result.readinessObservation = config.observationValue;
    if (config.observationPeer === 'malicious') result.readinessObservation = {sourceRevision:'PRIVATE_SOURCE',buildId:'PRIVATE_BUILD',sqlOutcome:'PRIVATE_OUTCOME',sqlElapsedMs:-1,doElapsedMs:Infinity,extra:'PRIVATE_CONTENT'};
    return result;
  }
  async readJobHealth() { await this.result(); return { schema: 'room.job-health/1', status: 'ok', jobs: [] }; }
  unblock() { this.release?.(); }
}
// A real zero-argument RPC method models the already deployed older peer.
export class LegacyBudgetProbe extends BudgetProbe {
  async probeStorage() { const config = await this.result(); return { ok: config.ok !== false, emailVerification: 'enforced' }; }
}
export class ObservedProjectRoom extends ProjectRoom {
  exercise(mode, diagnostics) {
    observations.length = 0;
    const originalPrepare = this.store.db.prepare;
    const originalPaused = this.paused;
    const sentinel = new Error('PRIVATE_SQL_FAILURE');
    let statements = 0;
    this.store.db.prepare = (...args) => {
      statements++;
      if (mode === 'sql-error' && args[0] === 'SELECT 1 AS ok') throw sentinel;
      return originalPrepare.apply(this.store.db, args);
    };
    this.paused = mode === 'paused';
    failTelemetry = mode === 'emitter-error';
    try {
      const result = this.probeStorage(diagnostics ? 'readiness-observation-v1' : undefined);
      return { result, statements, observations: [...observations] };
    } catch (error) {
      return { originalError: error === sentinel, statements, observations: [...observations] };
    } finally {
      this.store.db.prepare = originalPrepare;
      this.paused = originalPaused;
      failTelemetry = false;
    }
  }
}
export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname, stub = env.ROOM.getByName('invite-only-pilot');
    if (path === '/actual-ready') return worker.fetch(new Request(new URL('/api/ready',request.url),request),{...env,ROOM:env.ACTUAL},ctx);
    if (path === '/observations') return Response.json(observations);
    if (path === '/telemetry-failure') { failTelemetry = (await request.json()).enabled; return new Response('configured'); }
    if (path === '/actual') return Response.json(await env.ACTUAL.getByName('actual').exercise(new URL(request.url).searchParams.get('mode'),new URL(request.url).searchParams.get('diagnostics')==='1'));
    if (path === '/configure') { await stub.configure(await request.json()); return new Response('configured'); }
    if (path === '/count') return Response.json({ count: await stub.count() });
    if (path === '/unblock') { await stub.unblock(); return new Response('released'); }
    return worker.fetch(request, env, ctx);
  }
};
