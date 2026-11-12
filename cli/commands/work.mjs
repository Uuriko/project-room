import { connection } from './code.mjs';
import { RoomAgentClient } from '../../client/room-agent.mjs';
import { validId } from '../../src/events.js';

const validCursor = value => typeof value === 'string' && value.length <= 1024
  && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/.test(value);

// One bounded, read-only source page. Never silently turn a partial page into
// a complete list, or equate discoverability with authorization to start.
export async function workCommand(argv, io = {}) {
  const out = io.out ?? console.log;
  if (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0])) {
    out('room work [--focus all|needs_me|results|help_wanted] [--cursor <cursor>] [--limit <1-100>]\nRead one page of work. Default focus needs_me. Follow page.nextRead until hasMore is false; empty pages can have more. No writes or claims.');
    return 0;
  }
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--focus', '--cursor', '--limit'].includes(key) || Object.hasOwn(flags, key) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw Error('Use room work [--focus <focus>] [--cursor <cursor>] [--limit <1-100>]');
    flags[key] = argv[++i];
  }
  const focus = flags['--focus'] ?? 'needs_me', cursor = flags['--cursor'];
  if (!['all', 'needs_me', 'results', 'help_wanted'].includes(focus)) throw Error('Choose a supported work focus');
  if (cursor !== undefined && !validCursor(cursor)) throw Error('Use a returned work cursor');
  const rawLimit = flags['--limit'];
  if (rawLimit !== undefined && (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100)) throw Error('Use a limit from 1 to 100');
  const conn = await (io.connection ?? connection)({ env: io.env ?? process.env, cwd: io.cwd ?? process.cwd() });
  if (!validId(conn.memberId)) throw Error('The agent member ID is required. Use a saved room login or set ROOM_AGENT_MEMBER for an environment connection.');
  const client = new RoomAgentClient({ origin: conn.origin, roomId: conn.roomId, memberId: conn.memberId, token: conn.secret, fetchImpl: io.fetchImpl ?? fetch });
  const result = await client.orient({ paginate: true, focus, ...(cursor === undefined ? {} : { cursor }),
    ...(rawLimit === undefined ? {} : { limit: Number(rawLimit) }), signal: AbortSignal.timeout(30000) });
  const next = result.page?.nextRead?.arguments;
  let nextArgv = null;
  if (result.page?.hasMore) {
    const validLimit = rawLimit !== undefined ? next?.limit === Number(rawLimit)
      : next?.limit === undefined || (Number.isSafeInteger(next.limit) && next.limit >= 1 && next.limit <= 100 && next.limit === result.page.limit);
    if (next?.roomId !== conn.roomId || next.focus !== focus || !validCursor(next.cursor)
      || !validLimit) throw Error('Invalid work continuation; no output emitted');
    nextArgv = ['room', 'work', '--focus', focus, ...(next.limit === undefined ? [] : ['--limit', String(next.limit)]), '--cursor', next.cursor];
  }
  const output = JSON.stringify({ ...result, cli: { complete: result.page ? !result.page.hasMore : false, nextArgv } });
  if (typeof conn.secret === 'string' && conn.secret && output.includes(conn.secret)) throw Error('Work listing contains the connection credential; no output emitted');
  out(output); return 0;
}
