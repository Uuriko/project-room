// roomEventToSlack — pure mapping from Project Room events to Slack-style
// message payloads. Total function: every event type maps to a payload
// (known types get rich cards, unknown types get a compact fallback card),
// so the bot never silently drops an event. See SPEC.md for the table.
//
// Room event shape (from the room event log):
//   { id, sequence, type, actorId, at, data }
// ctx shape:
//   { channel, threadMap: Map<roomEventId, slackTs>, directory: Map<actorId, {slackId, displayName}> }

const clip = (value, max) =>
  typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ').trim().slice(0, max) : '';

export function escapeMrkdwn(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function actorName(actorId, directory) {
  const entry = directory?.get(actorId);
  return entry?.displayName ?? clip(actorId, 40) ?? 'room';
}

function section(text) {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function contextLine(text) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

function header(text) {
  return { type: 'header', text: { type: 'plain_text', text: clip(text, 150), emoji: true } };
}

function atLine(event) {
  return event.at ? ` · ${clip(event.at, 24)}` : '';
}

function threadTsFor(event, ctx) {
  const replyTo = event?.data?.replyToId ?? event?.data?.reply_to;
  return replyTo ? ctx?.threadMap?.get(replyTo) ?? null : null;
}

function basePayload({ event, ctx, text, blocks, thread_ts }) {
  return {
    channel: ctx?.channel,
    text, // mrkdwn fallback (Slack requires non-empty text)
    blocks,
    ...(thread_ts ? { thread_ts } : {}),
    _meta: { roomEventId: event.id, roomEventType: event.type, roomSequence: event.sequence },
  };
}

function mapMessagePosted(event, ctx) {
  const d = event.data ?? {};
  const author = actorName(d.authorId ?? event.actorId, ctx?.directory);
  const body = clip(d.body ?? '', 2800);
  const workTag = d.workItemId ? ` · _work ${escapeMrkdwn(clip(d.workItemId, 24))}_` : '';
  const text = `*${escapeMrkdwn(author)}*: ${escapeMrkdwn(body)}`;
  const blocks = [
    section(`*${escapeMrkdwn(author)}*${workTag}\n${escapeMrkdwn(body)}`),
    contextLine(`message ${clip(event.id, 12)}${atLine(event)}`),
  ];
  return basePayload({ event, ctx, text, blocks, thread_ts: threadTsFor(event, ctx) });
}

function mapMemberAccess(event, ctx) {
  const d = event.data ?? {};
  const target = actorName(d.memberId ?? d.targetId, ctx?.directory);
  const by = actorName(event.actorId, ctx?.directory);
  const action = d.access === false || d.action === 'revoked' ? 'revoked access for' : 'granted access to';
  const line = `:busts_in_silhouette: ${escapeMrkdwn(by)} ${action} ${escapeMrkdwn(target)}${atLine(event)}`;
  return basePayload({ event, ctx, text: line, blocks: [section(line)] });
}

function mapDmPosted(event, ctx) {
  const d = event.data ?? {};
  const from = actorName(d.authorId ?? event.actorId, ctx?.directory);
  const to = actorName(d.to ?? d.recipientId, ctx?.directory);
  const body = clip(d.body ?? '', 1200);
  const text = `:lock: *DM ${escapeMrkdwn(from)} → ${escapeMrkdwn(to)}*: ${escapeMrkdwn(body)}`;
  return basePayload({
    event, ctx, text,
    blocks: [section(text), contextLine(`dm ${clip(event.id, 12)}${atLine(event)}`)],
  });
}

function mapBond(event, ctx) {
  const d = event.data ?? {};
  const verb = event.type === 'bond.proposed' ? 'proposed' : event.type === 'bond.accept' ? 'accepted' : 'declined';
  const emoji = verb === 'proposed' ? ':handshake:' : verb === 'accepted' ? ':white_check_mark:' : ':x:';
  const who = actorName(event.actorId, ctx?.directory);
  const line = `${emoji} Bond ${verb} by ${escapeMrkdwn(who)}${d.amount ? ` · ${escapeMrkdwn(String(d.amount))}` : ''}${atLine(event)}`;
  return basePayload({ event, ctx, text: line, blocks: [header(`Bond ${verb}`), section(line)] });
}

function mapThreadReply(event, ctx) {
  const mapped = mapMessagePosted(event, ctx);
  mapped.blocks.unshift(contextLine(':speech_balloon: _thread reply_'));
  return mapped;
}

function mapClaim(event, ctx) {
  const d = event.data ?? {};
  const type = String(event.type);
  const state = type.includes('conflict') ? 'conflict'
    : type.includes('completed') ? 'completed'
    : type.includes('failed') ? 'failed'
    : type.includes('working') ? 'working' : 'claimed';
  const emoji = { completed: ':white_check_mark:', failed: ':rotating_light:', conflict: ':warning:', working: ':hammer_and_wrench:', claimed: ':bookmark:' }[state];
  const files = Array.isArray(d.files) ? d.files.map((f) => `\`${escapeMrkdwn(clip(String(f), 80))}\``).join(' ') : '';
  const title = d.taskId ? `Claim ${escapeMrkdwn(clip(String(d.taskId), 40))}` : `Work ${state}`;
  const line = `${emoji} *${title}* — ${escapeMrkdwn(actorName(d.ownerId ?? event.actorId, ctx?.directory))}${files ? `\n${files}` : ''}${atLine(event)}`;
  return basePayload({ event, ctx, text: line, blocks: [section(line)] });
}

function mapVerification(event, ctx) {
  const d = event.data ?? {};
  const pass = d.result === 'pass' || d.pass === true;
  const line = `${pass ? ':white_check_mark:' : ':x:'} Verification ${pass ? 'PASS' : 'FAIL'} — ${escapeMrkdwn(clip(d.check ?? d.name ?? 'check', 120))} by ${escapeMrkdwn(actorName(event.actorId, ctx?.directory))}${atLine(event)}`;
  return basePayload({ event, ctx, text: line, blocks: [section(line)] });
}

function mapOwnerDecision(event, ctx) {
  const d = event.data ?? {};
  const line = `:crown: Owner decision — ${escapeMrkdwn(clip(d.decision ?? 'recorded', 200))}${atLine(event)}`;
  return basePayload({ event, ctx, text: line, blocks: [header('Owner decision'), section(line)] });
}

function mapFallback(event, ctx) {
  const line = `:package: Room event \`${escapeMrkdwn(clip(event.type, 60))}\`${atLine(event)}`;
  return basePayload({
    event, ctx, text: line,
    blocks: [section(line), contextLine(`unmapped type — event ${clip(event.id, 12)}`)],
    // fallbacks are never threaded: threading a guess would misplace replies.
  });
}

const MAPPERS = Object.freeze({
  'message.posted': mapMessagePosted,
  'message.edited': mapMessagePosted,
  'thread_reply': mapThreadReply,
  'dm.posted': mapDmPosted,
  'member.access_changed': mapMemberAccess,
  'member.joined': mapMemberAccess,
  'bond.proposed': mapBond,
  'bond.accept': mapBond,
  'bond_decline': mapBond,
  'bond_revoked': mapBond,
  'work.claimed': mapClaim,
  'work_claim_conflict': mapClaim,
  'work_update': mapClaim,
  'work_review_rejected': mapClaim,
  'verification.pass': mapVerification,
  'verification.fail': mapVerification,
  'owner.decision': mapOwnerDecision,
  'owner_required': mapOwnerDecision,
});

export function roomEventToSlack(event, ctx = {}) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    throw new TypeError('roomEventToSlack requires an event object with a string type');
  }
  const mapper = MAPPERS[event.type] ?? mapFallback;
  const payload = mapper(event, ctx);
  payload._meta.mappedAs = mapper === mapFallback ? 'fallback' : 'mapped';
  return payload;
}

export function supportedEventTypes() {
  return Object.keys(MAPPERS);
}
