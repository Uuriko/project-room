import twilio from 'twilio';
import { createHash } from 'node:crypto';

// Verification/normalization only. Host must persist idempotently BEFORE replying
// to Twilio. This module does not acknowledge, send, or expose an HTTP endpoint.
export function readTwilioMessage({ rawBody, signature, contentType, connection }) {
  try {
    const c = connection;
    if (!c || c.active !== true || !c.accountId || !c.connectionId || !/^AC[a-f0-9]{32}$/i.test(c.accountSid)
      || typeof c.authToken !== 'string' || !c.authToken || typeof c.webhookUrl !== 'string'
      || new URL(c.webhookUrl).protocol !== 'https:' || new URL(c.webhookUrl).username || new URL(c.webhookUrl).password
      || new URL(c.webhookUrl).hash || !Array.isArray(c.addresses) || !c.addresses.length
      || typeof rawBody !== 'string' || Buffer.byteLength(rawBody) > 65536 || !rawBody.isWellFormed()
      || contentType?.split(';')[0].trim() !== 'application/x-www-form-urlencoded'
      || typeof signature !== 'string' || signature.length > 128) throw new Error();
    const form = new URLSearchParams(rawBody), params = Object.create(null);
    for (const [key, value] of form) {
      if (Object.hasOwn(params, key)) throw new Error();
      params[key] = value;
    }
    // Include every parameter, including future provider fields, in SDK validation.
    // webhookUrl comes from trusted config, never Host/X-Forwarded-* headers.
    if (!twilio.validateRequest(c.authToken, signature, c.webhookUrl, params)) throw new Error();
    const p = params, address = /^(?:whatsapp:)?\+[1-9][0-9]{6,14}$/;
    if (p.AccountSid !== c.accountSid || !/^SM[a-f0-9]{32}$/i.test(p.MessageSid)
      || !address.test(p.From) || !address.test(p.To) || !c.addresses.includes(p.To)
      || p.From.startsWith('whatsapp:') !== p.To.startsWith('whatsapp:')
      || p.NumMedia !== '0' || typeof p.Body !== 'string' || !p.Body.trim() || p.Body.length > 4096 || !p.Body.isWellFormed()) throw new Error();
    const channel = p.To.startsWith('whatsapp:') ? 'whatsapp' : 'sms';
    return { provider: 'twilio', channel, accountId: c.accountId, connectionId: c.connectionId,
      sourceId: 'tw-' + createHash('sha256').update(JSON.stringify([c.accountId,c.connectionId,c.accountSid,p.MessageSid])).digest('hex'),
      providerAccountId: c.accountSid, providerMessageId: p.MessageSid, sender: p.From, recipient: p.To, text: p.Body };
  } catch { throw new Error('twilio_message_unconfirmed'); }
}
