import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Plugin entry for the Room channel. The token stays in ROOM_AGENT_CONFIG.
// This file does not read or print it. A copied plugin without the source
// checkout cannot serve the channel.
const here = dirname(fileURLToPath(import.meta.url));
const candidates = [process.env.PROJECT_ROOM_ROOT, join(here, '../../..')].filter(value => typeof value === 'string' && value.trim());
const root = candidates.find(dir => existsSync(join(dir, 'scripts/room-listen.mjs')) && existsSync(join(dir, 'client/claude-channel.mjs')));
if (!root) {
  console.error(JSON.stringify({
    type: 'agent_connection_error', code: 'channel_runtime_missing',
    message: 'The Room channel runs from a Project Room source checkout. Set PROJECT_ROOM_ROOT to that checkout. This message contains no token.'
  }));
  process.exitCode = 1;
} else {
  const prompted = process.env.CLAUDE_PLUGIN_OPTION_ROOM_AGENT_CONFIG;
  if ((typeof process.env.ROOM_AGENT_CONFIG !== 'string' || !process.env.ROOM_AGENT_CONFIG.trim())
    && typeof prompted === 'string' && prompted.trim()) {
    process.env.ROOM_AGENT_CONFIG = prompted.trim();
  }
  const { main } = await import(pathToFileURL(join(root, 'scripts/room-listen.mjs')).href);
  await main();
}
