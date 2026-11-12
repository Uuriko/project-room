import { MAX_MESSAGE_BODY_CHARS } from '../src/events.js';
import { chargeCurrentReadBudget, remainingCurrentReadBytes, CurrentReadBudgetExceeded } from './current-room-repository.mjs';
import { ServiceError } from './service-error.mjs';

export const CURRENT_EVENT_ENVELOPE_BYTES = 128 * 1024;
// JSON.stringify may use six ASCII bytes per UTF-16 unit (\u0001, lone
// surrogates). Metadata keeps its existing bound; this is SQL work admission,
// not a larger protected JavaScript-input budget.
export const CURRENT_EVENT_RAW_MESSAGE_BYTES = MAX_MESSAGE_BODY_CHARS * 6 + CURRENT_EVENT_ENVELOPE_BYTES;
const unavailable = () => { throw new ServiceError(409, 'current_room_context_unavailable',
  'Event source exceeds bounded input or is malformed; cursor was not advanced'); };
const source = `SELECT id,body,length(CAST(body AS BLOB)) AS rawBytes FROM events
  WHERE room_id=? AND sequence=? AND length(CAST(id AS BLOB)) BETWEEN 1 AND 512
  AND length(CAST(body AS BLOB)) BETWEEN 2 AND ${CURRENT_EVENT_RAW_MESSAGE_BYTES}`;
const projection = `CASE WHEN json_extract(body,'$.type') IN ('message.posted','message.edited')
  THEN json_set(body,'$.data.body',NULL) ELSE body END`;
const selectEnvelope = `WITH source AS MATERIALIZED (${source}),
  valid AS MATERIALIZED (SELECT id,rawBytes,CASE WHEN json_valid(body) THEN body END AS body FROM source),
  projected AS MATERIALIZED (SELECT id,rawBytes,body,${projection} AS envelope,
    json_extract(body,'$.type') IN ('message.posted','message.edited') AS isMessage FROM valid),
  measured AS MATERIALIZED (SELECT id,rawBytes,envelope,length(CAST(envelope AS BLOB)) AS envelopeBytes,isMessage,
    json_type(body)='object' AND json_type(body,'$.type')='text' AND json_type(body,'$.data')='object' AS shapeValid,
    (SELECT count(*) FROM json_each(body) WHERE key='type') AS typeKeys,
    (SELECT count(*) FROM json_each(body) WHERE key='data') AS dataKeys,
    (SELECT count(*) FROM json_each(body,'$.data') WHERE key='body') AS bodyKeys,
    json_type(body,'$.data.body') IN ('text','null') AS bodyTypeValid,
    json_type(body,'$.data.redacted')='true' AS redactedBody FROM projected),
  checked AS MATERIALIZED (SELECT id,envelope,envelopeBytes,
    shapeValid=1 AND typeKeys=1 AND dataKeys=1
      AND envelopeBytes BETWEEN 2 AND ${CURRENT_EVENT_ENVELOPE_BYTES}
      AND ((isMessage=1 AND (bodyKeys=1 AND bodyTypeValid=1 OR bodyKeys=0 AND redactedBody=1))
        OR (isMessage=0 AND rawBytes<=${CURRENT_EVENT_ENVELOPE_BYTES}))
      AND rawBytes=? AS legal FROM measured)
  -- envelopeBytes is only reported for a legal envelope, so a NULL envelope with
  -- a number means "legal but it does not fit the remaining shared byte
  -- allowance" and a NULL envelopeBytes means malformed.
  SELECT id,CASE WHEN legal THEN envelopeBytes END AS envelopeBytes,
    CASE WHEN legal AND envelopeBytes<=? THEN envelope END AS envelope FROM checked`;

// The source scalar/prefix must be admitted by the caller before this point.
// One query returns one immutable row in the caller's read transaction. Its
// envelope is selected only after SQL admission, including the remaining shared
// byte allowance. Only the effective envelope crosses into JS; rawBytes remains available for
// the independent raw-SQL source-prefix ledger in each consumer.
export function readCurrentEventEnvelope(db, roomId, row, budget) {
  if (!db.isTransaction) throw Error('Current event envelopes require a read transaction');
  if (!Number.isSafeInteger(row?.sequence) || !Number.isSafeInteger(row.idBytes) || row.idBytes < 1 || row.idBytes > 512
    || !Number.isSafeInteger(row.bodyBytes) || row.bodyBytes < 2 || row.bodyBytes > CURRENT_EVENT_RAW_MESSAGE_BYTES) unavailable();
  chargeCurrentReadBudget(budget, row.idBytes + 32);
  const meta = db.prepare(selectEnvelope).get(roomId, row.sequence, row.bodyBytes, remainingCurrentReadBytes(budget));
  if (!meta || !Number.isSafeInteger(meta.envelopeBytes)
    || meta.envelopeBytes < 2 || meta.envelopeBytes > CURRENT_EVENT_ENVELOPE_BYTES) unavailable();
  // Legal but over the remaining shared byte allowance: the read budget is
  // spent, which a multi-window page treats as "return what you already hold"
  // rather than as a malformed source.
  if (typeof meta.envelope !== 'string') throw new CurrentReadBudgetExceeded();
  chargeCurrentReadBudget(budget, meta.envelopeBytes, 0);
  let event;
  try { event = JSON.parse(meta.envelope); } catch { unavailable(); }
  if (!event || Array.isArray(event) || event.id !== meta.id || event.roomId !== roomId
    || typeof event.type !== 'string' || typeof event.actorId !== 'string' || typeof event.at !== 'string'
    || Number.isNaN(Date.parse(event.at)) || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)
    || ['message.posted','message.edited'].includes(event.type) && event.data.body !== null) unavailable();
  return { id: meta.id, event, rawBytes: row.bodyBytes, envelopeBytes: meta.envelopeBytes };
}
