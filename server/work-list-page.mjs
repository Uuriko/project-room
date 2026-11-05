import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const WORK_PAGE_DEFAULT = 25;
export const WORK_PAGE_MAX = 100;
export function validWorkPage({ limit, cursor } = {}) {
  return (limit === undefined || Number.isSafeInteger(limit) && limit >= 1 && limit <= WORK_PAGE_MAX)
    && (cursor === undefined || typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 1024);
}
const fail = (code, message, status = 422) => { throw Object.assign(new Error(message), { code, status }); };

// Bounds delivered data, not snapshot/query cost. Reauthenticate and rebuild the
// current authorized selection before every continuation; never persist snapshots.
// Any selection/authority change requires restart rather than silent offset drift.
export function pageWorkListing(listing, args, secret, surface) {
  if (!validWorkPage(args)) fail('invalid_work_page', 'Use limit 1–100 and a returned cursor.');
  const limit = args.limit ?? WORK_PAGE_DEFAULT, work = listing.work;
  const replies = listing.replyRequests ?? [];
  // An observation clock can advance without changing eligibility. Keep every
  // semantic help field (including expiry-derived status) in the fingerprint.
  const stableWork = work.map(item => {
    if (!item.help) return item;
    const { evaluatedAt: _observedAt, ...help } = item.help;
    return { ...item, help };
  });
  const binding = createHash('sha256').update(JSON.stringify({ surface, roomId: listing.roomId,
    member: listing.member, through: listing.evaluatedThrough, replyThrough: listing.replyRequestsEvaluatedThrough,
    focus: args.focus ?? 'all', query: args.query?.trim() ?? null, sort: args.sort ?? null, limit, work: stableWork, replies })).digest('hex');
  const sign = payload => createHmac('sha256', secret).update(`room-work-page-v1:${payload}`).digest();
  let offset = 0;
  if (args.cursor !== undefined) {
    let saved;
    try {
      const parts = args.cursor.split('.');
      if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw Error();
      const [payload, signature] = parts, actual = Buffer.from(signature, 'base64url'), expected = sign(payload);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || actual.toString('base64url') !== signature) throw Error();
      saved = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (Buffer.from(JSON.stringify(saved)).toString('base64url') !== payload || Object.keys(saved).join(',') !== 'v,binding,offset'
        || saved.v !== 1 || !Number.isSafeInteger(saved.offset) || saved.offset < 1 || saved.offset % limit !== 0) throw Error();
    } catch { fail('invalid_work_cursor', 'Invalid work cursor. Restart room_list_work without cursor.'); }
    if (saved.binding !== binding) fail('stale_work_cursor', 'Work, access, or selection changed. Restart room_list_work without cursor.', 409);
    offset = saved.offset;
    if (offset >= Math.max(work.length, replies.length)) fail('invalid_work_cursor', 'Work cursor is past this selection. Restart without cursor.');
  }
  const end = offset + limit, hasMore = end < Math.max(work.length, replies.length);
  const payload = Buffer.from(JSON.stringify({ v: 1, binding, offset: end })).toString('base64url');
  const nextCursor = hasMore ? `${payload}.${sign(payload).toString('base64url')}` : null;
  const nextArgs = { ...(surface === 'hosted' ? { roomId: listing.roomId } : {}),
    ...(args.focus === undefined ? {} : { focus: args.focus }), ...(args.query === undefined ? {} : { query: args.query }),
    ...(args.sort === undefined ? {} : { sort: args.sort }), limit, cursor: nextCursor };
  return { ...listing, work: work.slice(offset, end),
    ...(listing.replyRequests ? { replyRequests: replies.slice(offset, end) } : {}),
    ...(listing.selection ? { selection: { ...listing.selection, shown: work.slice(offset, end).length,
      limit, hasMore, guidance: `${listing.selection.guidance ?? ''} Follow page.nextRead for remaining items; a stale cursor requires restarting.`.trim() } } : {}),
    page: { limit, totalWork: work.length, totalReplyRequests: replies.length, hasMore, nextCursor,
      nextRead: hasMore ? { tool: 'room_list_work', arguments: nextArgs } : null,
      consistency: 'restart_on_change' } };
}
