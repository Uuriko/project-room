/**
 * bridge/lib/socket-client.mjs — herdr Unix-socket JSON client.
 *
 * Protocol (risk-review §1.2): newline-delimited JSON, one request per line,
 * responses echo the request `id`. One connection per call (cheap over a Unix
 * socket, avoids interleaving bugs); `subscribe()` holds a persistent
 * connection for the SSE path.
 *
 * The client performs exactly ONE attempt with a timeout. Retry policy lives
 * in bridge.mjs (reads 3x; writes only on no-response with the same
 * idempotency key). `err.gotResponse` distinguishes "no response" (safe to
 * retry a write) from "response received" (never retry a write).
 */
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { assertSocketMethodAllowed } from './fence.mjs';
import { bridgeError, fromSocketError } from './errors.mjs';

function cleanSocketError(err) {
  // Never surface raw socket error strings — they can embed socket paths.
  const e = bridgeError('transport_error', `socket failure: ${err.code ?? 'error'}`);
  e.gotResponse = false;
  return e;
}

export class HerdrSocketClient {
  callOnce(socketPath, method, params, timeoutMs) {
    assertSocketMethodAllowed(method);
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      let buf = '';
      let settled = false;
      let gotResponse = false;
      const sock = createConnection(socketPath);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        sock.destroy();
        const e = bridgeError('timeout', `socket call timed out after ${timeoutMs}ms`);
        e.gotResponse = gotResponse;
        e.socketMethod = method;
        reject(e);
      }, timeoutMs);
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        fn(v);
      };
      sock.on('connect', () => {
        sock.write(JSON.stringify({ id, method, params }) + '\n');
      });
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id !== id) continue; // not our response
          gotResponse = true;
          if (msg.error) {
            const e = fromSocketError(msg.error);
            e.gotResponse = true;
            done(reject, e);
          } else {
            done(resolve, msg.result);
          }
          return;
        }
      });
      sock.on('error', (err) => {
        const e = cleanSocketError(err);
        e.gotResponse = gotResponse;
        done(reject, e);
      });
      sock.on('close', () => {
        if (!settled) {
          const e = bridgeError('transport_error', 'socket closed before responding');
          e.gotResponse = gotResponse;
          done(reject, e);
        }
      });
    });
  }

  /**
   * Persistent subscription for the SSE path.
   * @returns {Promise<{close():void}>} resolves once subscribed.
   */
  subscribe(socketPath, params, onEvent, onError) {
    assertSocketMethodAllowed('events.subscribe');
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      let buf = '';
      let subscribed = false;
      const sock = createConnection(socketPath);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(bridgeError('timeout', 'subscribe handshake timed out'));
      }, 10_000);
      const close = () => { clearTimeout(timer); sock.destroy(); };
      sock.on('connect', () => {
        sock.write(JSON.stringify({ id, method: 'events.subscribe', params }) + '\n');
      });
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (!subscribed) {
            if (msg.id === id && !msg.error) {
              subscribed = true;
              clearTimeout(timer);
              resolve({ close });
            } else if (msg.id === id && msg.error) {
              clearTimeout(timer);
              sock.destroy();
              reject(fromSocketError(msg.error));
            }
            continue;
          }
          if (msg.event !== undefined) {
            try { onEvent(msg.event); } catch (e) { onError?.(e); }
          }
        }
      });
      sock.on('error', (err) => {
        if (!subscribed) { clearTimeout(timer); reject(cleanSocketError(err)); }
        else onError?.(cleanSocketError(err));
      });
      sock.on('close', () => {
        if (!subscribed) { clearTimeout(timer); reject(bridgeError('transport_error', 'subscribe socket closed')); }
        else onError?.(bridgeError('transport_error', 'subscribe stream closed'));
      });
    });
  }
}
