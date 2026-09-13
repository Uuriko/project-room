import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// HTTP Events API boundary only. Durable dedupe/commit must precede HTTP 200.
// Socket Mode has a different authenticated envelope and must not call this.
export function readSlackEvent({ rawBody, timestamp, signature, connection, now = Date.now() }) {
  try {
    const c = connection;
    if (!c || c.active !== true || !c.accountId || !c.connectionId || !c.teamId || !c.appId
      || typeof c.signingSecret !== 'string' || !c.signingSecret || !Array.isArray(c.channelIds)
      || typeof rawBody !== 'string' || Buffer.byteLength(rawBody) > 262144 || !rawBody.isWellFormed()
      || !/^\d{10}$/.test(timestamp) || !Number.isFinite(now) || Math.abs(now / 1000 - Number(timestamp)) > 300
      || typeof signature !== 'string' || !/^v0=[a-f0-9]{64}$/.test(signature)) throw new Error();
    const expected = 'v0=' + createHmac('sha256',c.signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
    if (!timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) throw new Error();
    const body = JSON.parse(rawBody);
    if (body.type === 'url_verification') {
      if (typeof body.challenge !== 'string' || body.challenge.length > 256) throw new Error();
      return { kind: 'challenge', challenge: body.challenge };
    }
    if (body.type !== 'event_callback' || body.team_id !== c.teamId || body.api_app_id !== c.appId
      || typeof body.event_id !== 'string' || !/^Ev[A-Za-z0-9]+$/.test(body.event_id)) throw new Error();
    const e = body.event;
    if (!e || !c.channelIds.includes(e.channel)) return {kind:'ignored', reason:'outside_selected_channels'};
    // Edits, deletions, files and bot events require separate explicit policies.
    if (e.type !== 'message' || e.subtype || e.bot_id) return {kind:'ignored',reason:'unsupported_event'};
    if (!/^\d{10}\.\d{6}$/.test(e.ts) || typeof e.user !== 'string' || !/^[UW][A-Z0-9]+$/.test(e.user)
      || typeof e.text !== 'string' || !e.text.trim() || e.text.length > 4096 || !e.text.isWellFormed()) throw new Error();
    return {kind:'message', provider:'slack', accountId:c.accountId,connectionId:c.connectionId,
      sourceId:'sl-'+createHash('sha256').update(JSON.stringify([c.accountId,c.connectionId,c.teamId,e.channel,e.ts])).digest('hex'),
      eventId:body.event_id,conversationId:e.channel,providerMessageId:e.ts,sender:e.user,text:e.text};
  } catch { throw new Error('slack_event_unconfirmed'); }
}
