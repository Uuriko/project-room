#!/usr/bin/env node
/**
 * bridge/herdr-bridge.mjs — host-side bridge service entry point.
 *
 * Translates the domain API (HTTPS, bearer-per-tenant) to herdr's Unix-socket
 * JSON protocol (per-tenant servers, own UIDs). Binds 127.0.0.1 only;
 * reachability from the edge is via Cloudflare Tunnel or direct TLS
 * termination (see bridge/deploy/).
 *
 * Env:
 *   BRIDGE_MASTER_SECRET       per-host master secret (32+ random bytes) — required
 *   BRIDGE_MASTER_SECRET_PREV  previous generation during rotation (optional)
 *   BRIDGE_KEY_ID              current key generation id (default "gen1")
 *   BRIDGE_KEY_ID_PREV         previous generation id (rotation window)
 *   BRIDGE_TENANTS_FILE        default /etc/herdr-bridge/tenants.json
 *   BRIDGE_AUDIT_LOG           default /var/log/herdr-bridge/audit.jsonl
 *   BRIDGE_PORT                default 8443
 *   BRIDGE_BIND                default 127.0.0.1
 */
import { createBridge, BRIDGE_VERSION } from './lib/bridge.mjs';

const bridge = createBridge();

process.on('SIGTERM', () => bridge.stop().then(() => process.exit(0)));
process.on('SIGINT', () => bridge.stop().then(() => process.exit(0)));

bridge.start().then(() => {
  console.log(`[herdr-bridge] v${BRIDGE_VERSION} listening on ${process.env.BRIDGE_BIND ?? '127.0.0.1'}:${bridge.port}`);
}).catch((err) => {
  console.error(`[herdr-bridge] failed to start: ${err.message}`);
  process.exit(1);
});
