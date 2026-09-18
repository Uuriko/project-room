// Room -> SMS send payloads. Pure and fixture-driven: builds the provider
// send payload (Twilio-shaped) with segmentation-aware accounting — no HTTP,
// no credentials. Long bodies are split into concatenated segments so the
// room can preview exactly what the carrier will deliver.
import { requireContract } from "./channel-connection.mjs";
// GSM-7 default alphabet (single chars cost 1 septet).
const GSM7_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
// GSM-7 extension table (cost 2 septets: escape + char).
const GSM7_EXT = "^{}\\[~]|€";
const gsm7Units = ch => GSM7_BASIC.includes(ch) ? 1 : GSM7_EXT.includes(ch) ? 2 : -1;
// Encoding + septet/code-unit accounting for a body.
export function analyzeSmsBody(body) {
  requireContract(typeof body === "string" && body.isWellFormed(), "invalid_sms_outbound");
  let encoding = "gsm7", units = 0;
  for (const ch of body) {
    const cost = gsm7Units(ch);
    if (cost < 0) { encoding = "ucs2"; break; }
    units += cost;
  }
  if (encoding === "ucs2") { let n = 0; for (const ch of body) n += ch.length; units = n; } // UTF-16 code units incl. surrogates
  const single = encoding === "gsm7" ? 160 : 70, concat = encoding === "gsm7" ? 153 : 67;
  const segments = units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / concat);
  return { encoding, units, segments, perSegment: segments <= 1 ? single : concat };
}
// Split a body into concatenated segment strings without breaking GSM-7
// extension pairs or Unicode surrogate pairs.
export function segmentSms(body) {
  const { encoding, segments: total } = analyzeSmsBody(body);
  requireContract(total >= 1 && total <= 10, "invalid_sms_outbound");
  const limit = total <= 1 ? (encoding === "gsm7" ? 160 : 70) : (encoding === "gsm7" ? 153 : 67);
  const chars = [...body], segments = [];
  let current = "", used = 0;
  const costOf = ch => encoding === "gsm7" ? gsm7Units(ch) : ch.length;
  for (const ch of chars) {
    const cost = costOf(ch);
    if (used + cost > limit) { segments.push(current); current = ""; used = 0; }
    current += ch; used += cost;
  }
  segments.push(current);
  return { encoding, segments };
}
const phone = value => { requireContract(typeof value === "string" && /^\+[1-9]\d{1,14}$/.test(value), "invalid_sms_outbound"); return value; };
// Build the provider send payload for one room message. The full body ships
// as `body`; `segments` previews the carrier-visible split.
export function buildSmsSend({ to, from, body, callbackUrl = null }) {
  const analysis = analyzeSmsBody(body);
  requireContract(analysis.segments >= 1 && analysis.segments <= 10, "invalid_sms_outbound");
  requireContract(callbackUrl === null || (typeof callbackUrl === "string" && /^https:\/\//.test(callbackUrl)), "invalid_sms_outbound");
  const { segments } = segmentSms(body);
  return Object.freeze({ to: phone(to), from: phone(from), body, encoding: analysis.encoding,
    segmentCount: segments.length, segments: Object.freeze(segments), callbackUrl });
}
