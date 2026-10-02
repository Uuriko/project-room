import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { agentConnectionFromEnvironment, ConnectionError, connectionDiagnostic } from '../client/agent-connection.mjs';
import { AgentWakeClient } from '../client/agent-wake.mjs';
import { roomEventPointer, serveClaudeRoomChannel } from '../client/claude-channel.mjs';

const MODES = new Set(['channel', 'poll', 'webhook']);

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv[0] !== '--mode' || !MODES.has(argv[1])) throw new ConnectionError('usage_error');
  const mode = argv[1];
  let host, cadence, webhookUrl;
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i], value = argv[i + 1];
    if (value === undefined) throw new ConnectionError('usage_error');
    if (flag === '--host') host = value;
    else if (flag === '--cadence-seconds') cadence = value;
    else if (flag === '--webhook-url') webhookUrl = value;
    else throw new ConnectionError('usage_error');
    i += 1;
  }
  if (host === undefined || cadence === undefined) throw new ConnectionError('usage_error');
  if ((mode === 'webhook') !== (webhookUrl !== undefined)) throw new ConnectionError('usage_error');
  const cadenceSeconds = Number(cadence);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(host) || !Number.isInteger(cadenceSeconds) || cadenceSeconds < 1 || cadenceSeconds > 3600) throw new ConnectionError('invalid_config');
  return { mode, host, cadenceSeconds, webhookUrl };
}

function webhookCall(url, token) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new ConnectionError('invalid_config'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (token && url.includes(token))) throw new ConnectionError('invalid_config');
  return {
    jsonrpc: '2.0', method: 'tools/call',
    params: { name: 'webhook_subscribe', arguments: { url: parsed.href, events: ['agent.wake'] } }
  };
}

async function writeLine(output, value) {
  const line = JSON.stringify(value) + '\n';
  await new Promise((resolve, reject) => output.write(line, error => error ? reject(error) : resolve()));
}

// One receiving entry. Channel speaks MCP. Poll prints pointers. Webhook prints
// the subscribe call and does not listen. None of the modes start a model.
export async function listen(argv = process.argv.slice(2), io = {}) {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const env = io.env ?? process.env;
  const report = io.report ?? (value => { console.error(JSON.stringify(value)); process.exitCode = 1; });
  const { mode, host, cadenceSeconds, webhookUrl } = parseArgs(argv);
  if (!env.ROOM_AGENT_CONFIG) throw new ConnectionError('usage_error');
  const connection = agentConnectionFromEnvironment(env);
  if (mode === 'webhook') {
    await writeLine(output, webhookCall(webhookUrl, connection.token));
    return;
  }
  if (mode === 'channel') {
    const server = serveClaudeRoomChannel({
      connection, hostId: host, cadenceSeconds, input, output, report, fetchImpl: io.fetchImpl
    });
    const stop = () => server.stop();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { await server.done; }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    return;
  }
  const controller = new AbortController();
  const fetchImpl = io.fetchImpl ?? fetch;
  const scopedFetch = (url, options = {}) => fetchImpl(url, { ...options,
    signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
  const wake = new AgentWakeClient({ connection, fetchImpl: scopedFetch });
  const delivered = new Set();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    let started = false;
    while (!controller.signal.aborted) {
      const result = await wake.wait({ hostId: host, cadenceSeconds, waitMs: started ? 25000 : 0 });
      started = true;
      for (const signal of result.pendingWakes) {
        const pointer = roomEventPointer(signal, connection.roomId);
        if (!pointer || delivered.has(pointer.signalId)) continue;
        if (delivered.size >= 256) throw new ConnectionError('channel_pending_limit');
        await writeLine(output, pointer);
        delivered.add(pointer.signalId);
      }
      await delay(1000, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (!controller.signal.aborted) report(connectionDiagnostic(error));
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}

export async function main(argv = process.argv.slice(2), io) {
  try { await listen(argv, io); }
  catch (error) {
    const report = io?.report ?? (value => { console.error(JSON.stringify(value)); process.exitCode = 1; });
    report(connectionDiagnostic(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
