import { main } from './room-listen.mjs';

// Claude Code spawns this file directly. Same checks and channel as
// `room-listen --mode channel`. It starts no model.
await main(['--mode', 'channel', ...process.argv.slice(2)]);
