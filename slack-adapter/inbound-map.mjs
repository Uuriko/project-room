// slackEventToRoom — maps inbound Slack Events API payloads (as emitted by
// FakeSlack.emitSlackEvent) to Project Room command objects. Handles:
//   - app_mention: strips the leading bot mention, becomes a room message
//   - message (plain): becomes a room message
// Ignores: url_verification (handled by verify), bot echoes (own bot user /
// bot_message subtype), message_changed / message_deleted, anything without
// usable text.
//
// verifySlackSignature implements Slack's v0 request-signing scheme
// (HMAC-SHA256 over "v0:timestamp:body", compared against the
// "v0=<hex>" header) so the adapter is wire-ready; in fake mode the shared
// secret is FAKE_SIGNING_SECRET. Timestamp freshness (>5 min) is rejected.

import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

export const FAKE_SIGNING_SECRET = 'fake-signing-secret-do-not-use';

export function verifySlackSignature({ signingSecret, timestamp, rawBody, signature }) {
  if (!signingSecret || !timestamp || rawBody === undefined || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > 5 * 60) return false; // stale request
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac('sha256', signingSecret).update(base).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

const MENTION_RE = /^<@[^>\s]+>\s*/;

function stripMention(text) {
  return String(text ?? '').replace(MENTION_RE, '').trim();
}

function baseCommand({ event, body, ctx }) {
  return {
    id: randomUUID(),
    type: 'message.posted',
    data: {
      messageId: randomUUID(),
      body,
      authorId: event.user ?? 'unknown',
      channel: 'room',
      via: 'slack-adapter',
      slackTs: event.ts ?? null,
      slackChannel: event.channel ?? ctx?.channel ?? null,
    },
  };
}

/**
 * @param {object} envelope - Events API envelope: { type, event: {...} }
 * @param {object} ctx - { botUserId, channel }
 * @returns room command object, or null when the event is ignorable.
 */
export function slackEventToRoom(envelope, ctx = {}) {
  if (!envelope || typeof envelope !== 'object') return null;
  if (envelope.type === 'url_verification') return null;

  const event = envelope.event ?? envelope;
  const kind = event.type;

  // Echo suppression: never relay the bot's own messages.
  if (event.bot_id || event.user === ctx.botUserId) return null;
  if (event.subtype && event.subtype !== 'me_message') return null;

  if (kind === 'app_mention') {
    const body = stripMention(event.text);
    if (!body) return null;
    return baseCommand({ event, body, ctx });
  }

  if (kind === 'message') {
    const body = String(event.text ?? '').trim();
    if (!body) return null;
    return baseCommand({ event, body, ctx });
  }

  return null; // unknown inbound types are ignored, not errored
}
