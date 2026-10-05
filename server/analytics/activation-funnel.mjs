// AN-FUNNEL-1: signup -> first message -> first reply, from already-recorded data.
//
// Read-only aggregation. No new event types, no schema changes, no product
// behavior changes. Inputs come from data the server already records:
//
//   signups:     analytics_events rows with name='signup'
//                (the tail derives these from the accounts table; actorId/accountId
//                is the account, at is creation time)
//   memberships: member_accounts rows (room_id, member_id, account_id).
//                This table only ever binds HUMAN members to accounts
//                (ensureHumanAccountBinding rejects kind != "human"), so the
//                account's member set is exactly its human identities.
//   messages:    events rows with body.type='message.posted'
//                (author is body.actorId, time is body.at)
//
// Definitions (documented in the report output too):
//   signup:        earliest signup event for the account.
//   first message: earliest message.posted authored by one of the account's own
//                  members at or after signup. Pre-signup rows are excluded as
//                  clock-skew noise.
//   first reply:   earliest message.posted in the SAME room by a DIFFERENT member
//                  strictly after the first message. This is deliberately loose
//                  and room-level: any other member talking back counts as a
//                  reply. Threaded replyToId is not required; most rooms do not
//                  thread, and the activation question is "did anyone talk back".
//                  DMs (dm.posted) are out of scope for this funnel.

function minutesBetween(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 60000);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(rank, sorted.length - 1))];
}

export function activationFunnel({ signups = [], memberships = [], messages = [], memberKinds = {} } = {}) {
  const signupAt = new Map();
  for (const row of signups) {
    if (typeof row?.accountId !== "string" || !Number.isFinite(row?.at)) continue;
    const prior = signupAt.get(row.accountId);
    if (prior == null || row.at < prior) signupAt.set(row.accountId, row.at);
  }

  const membersOf = new Map();
  for (const row of memberships) {
    if (typeof row?.accountId !== "string" || typeof row?.memberId !== "string") continue;
    let set = membersOf.get(row.accountId);
    if (!set) {
      set = new Set();
      membersOf.set(row.accountId, set);
    }
    set.add(row.memberId);
  }

  const byRoom = new Map();
  for (const row of messages) {
    if (typeof row?.roomId !== "string" || typeof row?.authorId !== "string" || !Number.isFinite(row?.at)) continue;
    let list = byRoom.get(row.roomId);
    if (!list) {
      list = [];
      byRoom.set(row.roomId, list);
    }
    list.push(row);
  }
  for (const list of byRoom.values()) list.sort((a, b) => a.at - b.at);

  const accounts = [];
  for (const [accountId, start] of signupAt) {
    const own = membersOf.get(accountId) ?? new Set();
    let firstMessage = null;
    for (const [, list] of byRoom) {
      for (const message of list) {
        if (message.at < start) continue;
        if (!own.has(message.authorId)) continue;
        if (!firstMessage || message.at < firstMessage.at) {
          firstMessage = { at: message.at, roomId: message.roomId };
        }
        break;
      }
    }
    let firstReply = null;
    if (firstMessage) {
      const list = byRoom.get(firstMessage.roomId) ?? [];
      for (const message of list) {
        if (message.at <= firstMessage.at) continue;
        if (own.has(message.authorId)) continue;
        const kind = memberKinds[message.authorId];
        firstReply = {
          at: message.at,
          authorId: message.authorId,
          authorKind: kind === "agent" || kind === "human" ? kind : "unknown"
        };
        break;
      }
    }
    accounts.push({
      accountId,
      signupAt: start,
      firstMessageAt: firstMessage?.at ?? null,
      firstReplyAt: firstReply?.at ?? null,
      firstReplyAuthorKind: firstReply?.authorKind ?? null,
      minutesToFirstMessage: firstMessage ? minutesBetween(start, firstMessage.at) : null,
      minutesToFirstReply: firstMessage && firstReply ? minutesBetween(firstMessage.at, firstReply.at) : null
    });
  }
  accounts.sort((a, b) => a.signupAt - b.signupAt);

  const messaged = accounts.filter(a => a.firstMessageAt != null);
  const replied = accounts.filter(a => a.firstReplyAt != null);
  const toMessage = messaged.map(a => a.minutesToFirstMessage).filter(v => v != null);
  const toReply = replied.map(a => a.minutesToFirstReply).filter(v => v != null);
  const summary = {
    signups: accounts.length,
    messaged: messaged.length,
    messagedRate: accounts.length ? messaged.length / accounts.length : null,
    replied: replied.length,
    repliedRate: accounts.length ? replied.length / accounts.length : null,
    repliedOfMessagedRate: messaged.length ? replied.length / messaged.length : null,
    medianMinutesToFirstMessage: median(toMessage),
    p90MinutesToFirstMessage: percentile(toMessage, 90),
    medianMinutesToFirstReply: median(toReply),
    p90MinutesToFirstReply: percentile(toReply, 90)
  };
  return { accounts, summary };
}

export const ACTIVATION_FUNNEL_DEFINITIONS = Object.freeze({
  signup: "Earliest analytics_events row with name='signup' for the account (derived from the accounts table by the analytics tail).",
  firstMessage: "Earliest message.posted authored by one of the account's own human members (via member_accounts) at or after signup.",
  firstReply: "Earliest message.posted in the same room by a different member strictly after the first message. Room-level and loose by design: any other member talking back counts; threaded replyToId is not required. DMs are out of scope."
});
