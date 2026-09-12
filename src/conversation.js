import { replyDraftKey, validReplyDraft, replyDraftData } from "./reply-requests.js";
// Conversation structure is derived from immutable reply links, including older logs.
export const REACTIONS = Object.freeze({ like: "👍", heart: "❤️", celebrate: "🎉", thinking: "🤔" });

export function reactionPills(reactions = {}) {
  return Object.entries(REACTIONS).map(([key, symbol]) => {
    const memberIds = [...(reactions?.[key] || [])];
    return { key, symbol, memberIds, count: memberIds.length, used: memberIds.length > 0 };
  });
}

// Composition, key repeat, and touch Return must never accidentally submit.
export function sendsOnEnter(event, touchKeyboard = false) {
  return event.key === "Enter" && !event.shiftKey && !event.altKey
    && !event.isComposing && event.keyCode !== 229 && !event.repeat
    && Boolean(!touchKeyboard || event.ctrlKey || event.metaKey);
}

export function escapeChatAction({ dialogOpen = false, mentionOpen = false, replyOpen = false, inThread = false } = {}) {
  if (dialogOpen) return null;
  if (mentionOpen) return "hide-mentions";
  if (replyOpen) return "clear-reply";
  if (inThread) return "leave-thread";
  return null;
}

export const GROUP_WINDOW_MS = 7 * 60 * 1000;

export function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dayLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(d);
}

export function messageCluster(messages, index) {
  const m = messages[index], prev = index > 0 ? messages[index - 1] : null;
  const dayStart = !prev || dayKey(prev.createdAt) !== dayKey(m.createdAt);
  const grouped = Boolean(!dayStart && prev && prev.authorId === m.authorId
    && Math.abs(Date.parse(m.createdAt) - Date.parse(prev.createdAt)) <= GROUP_WINDOW_MS);
  return { grouped, dayStart, dayLabel: dayStart ? dayLabel(m.createdAt) : "" };
}

export function mentionQuery(text, caret) {
  const value = String(text ?? "");
  const pos = Number.isInteger(caret) ? Math.min(Math.max(caret, 0), value.length) : value.length;
  const before = value.slice(0, pos);
  const match = /(^|[\s])@([^\s@]{0,80})$/.exec(before);
  if (!match) return null;
  return { start: before.length - match[2].length - 1, query: match[2] };
}

export function mentionMatches(members, query) {
  const q = String(query ?? "").trim().toLocaleLowerCase();
  return (members || []).filter(m => m && m.active !== false && m.displayName
    && (!q || m.displayName.toLocaleLowerCase().includes(q) || String(m.id).toLocaleLowerCase().includes(q)))
    .slice(0, 8);
}

export function kindLabel(kind) {
  return kind === "agent" ? "Agent" : "Person";
}

// A People-row click addresses that member. The panel itself is a <details>;
// only disclosures *inside* the row (Room capabilities) should swallow the click.
export function shouldAddressPresenceClick(target) {
  const row = target?.closest?.(".presence-member");
  if (!row) return false;
  const block = target.closest("details, summary, button, a");
  return !(block && row.contains(block));
}

const PRESENCE_ONLINE_MS = 15 * 60 * 1000;
const RUNNING_SESSION = new Set(["processing", "active"]);
const ENGAGED_WORK = new Set(["accepted", "working", "blocked"]);

function workList(workItems) {
  return Object.values(workItems ?? {}).filter(item => item && typeof item === "object" && !item.supersededBy && item.state !== "superseded");
}

function waitingOnMember(item, memberId) {
  if (!item || item.supersededBy || item.state === "superseded") return false;
  if (item.accountableMemberId === memberId && (item.state === "proposed" || ENGAGED_WORK.has(item.state))) return true;
  if (item.independentVerificationRequired && item.verifierMemberId === memberId
    && item.state === "completed" && item.receipt?.eventId && !item.verification?.result) return true;
  if (item.ownerDecisionRequired && item.humanDecisionMakerId === memberId
    && item.state === "completed" && item.receipt?.eventId && !item.decision?.decision) return true;
  return false;
}

function latestStamp(item) {
  return item?.updatedAt || item?.heartbeat_at || item?.createdAt || "";
}

function byLatest(a, b) {
  return latestStamp(b).localeCompare(latestStamp(a)) || String(a.id).localeCompare(String(b.id));
}

// Loud @agent handle. Humans keep a readable name; IDs stay in details.
export function memberHandle(member, label) {
  const name = String(label ?? member?.displayName ?? "").trim();
  if (!name) return "";
  if (member?.kind !== "agent") return name;
  return name.startsWith("@") ? name : `@${name}`;
}

export function presenceLabel(presence) {
  return presence === "online" ? "Online" : presence === "offline" ? "Offline" : "Away";
}

// Presence is derived from room work + recent chat. No extra people-data store.
export function memberPresence(member, { workItems, messages, now } = {}) {
  if (!member || member.active === false) return "offline";
  const clock = Number.isFinite(now) ? now : Date.now();
  const items = workList(workItems);
  if (items.some(item => item.accountableMemberId === member.id
    && (ENGAGED_WORK.has(item.state) || RUNNING_SESSION.has(item.status)))) return "online";
  if (items.some(item => waitingOnMember(item, member.id))) return "online";
  const last = [...(messages || [])].reverse().find(message => message?.authorId === member.id);
  const at = last && Date.parse(last.createdAt ?? last.at);
  if (Number.isFinite(at) && clock - at < PRESENCE_ONLINE_MS) return "online";
  return "away";
}

// One-line “what they’re on”: current work title, else kind. Not a profile.
export function memberOnLine(member, { workItems, now } = {}) {
  if (!member || member.active === false) return "";
  const items = workList(workItems);
  const waiting = items.filter(item => waitingOnMember(item, member.id)).sort(byLatest);
  if (waiting[0]?.title) return waiting[0].title;
  const own = items.filter(item => item.accountableMemberId === member.id && item.state !== "completed").sort(byLatest);
  if (own[0]?.title) return own[0].title;
  return "";
}

export function memberStatus(member, context) {
  if (!member || member.active === false) return "access revoked";
  const line = context ? memberOnLine(member, context) : "";
  return line || kindLabel(member.kind);
}

// Compact Done receipt for an agent who posted completion. Not chat spam.
export function memberDoneChip(member, { workItems } = {}) {
  if (!member || member.kind !== "agent" || member.active === false) return null;
  const done = workList(workItems)
    .filter(item => item.receipt?.eventId && (item.accountableMemberId === member.id || item.receipt.producerId === member.id))
    .sort(byLatest)[0];
  if (!done) return null;
  const title = String(done.receipt.summary || done.title || "").trim();
  return { label: "Done", title, workItemId: done.id };
}

export function addressMember(text, caret, member) {
  if (!member?.displayName) return { body: String(text ?? ""), caret: Number.isInteger(caret) ? caret : String(text ?? "").length, toMemberId: member?.id ?? "" };
  const found = mentionQuery(text, caret);
  if (found) return insertMention(text, caret, found.start, member);
  const value = String(text ?? "");
  const pos = Number.isInteger(caret) ? Math.min(Math.max(caret, 0), value.length) : value.length;
  const before = value.slice(0, pos), after = value.slice(pos);
  const padBefore = before && !/[\s]$/.test(before) ? " " : "";
  const label = `@${member.displayName}`;
  const padAfter = after.startsWith(" ") ? "" : " ";
  return { body: `${before}${padBefore}${label}${padAfter}${after}`, caret: before.length + padBefore.length + label.length + (padAfter ? 1 : 0), toMemberId: member.id };
}

export function insertMention(text, caret, start, member) {
  const value = String(text ?? "");
  const pos = Number.isInteger(caret) ? caret : value.length;
  const at = Number.isInteger(start) ? start : 0;
  const label = `@${member.displayName}`;
  const after = value.slice(pos);
  const body = `${value.slice(0, at)}${label}${after.startsWith(" ") ? after : ` ${after}`}`;
  return { body, caret: at + label.length + (after.startsWith(" ") ? 0 : 1), toMemberId: member.id };
}

const mentionRegExpSpecial = new Set(".*+?^${}()|[]\\");
const escapeMentionName = value => [...String(value)].map(ch => mentionRegExpSpecial.has(ch) ? `\\${ch}` : ch).join("");

export function mentionHtml(body, members, esc) {
  const text = String(body ?? "");
  const names = [...(members || [])].filter(m => m?.displayName).sort((a, b) => b.displayName.length - a.displayName.length);
  if (!names.length) return esc(text);
  const pattern = new RegExp(`@(?:${names.map(m => escapeMentionName(m.displayName)).join("|")})(?=\\s|$)`, "g");
  let out = "", last = 0, match;
  while ((match = pattern.exec(text))) {
    out += esc(text.slice(last, match.index));
    const label = match[0].slice(1);
    const member = names.find(m => m.displayName === label);
    const kind = member?.kind === "agent" ? " agent" : "";
    const chip = member?.id
      ? `<button type="button" class="mention${kind}" data-mention-id="${esc(member.id)}">${esc(match[0])}</button>`
      : `<span class="mention${kind}">${esc(match[0])}</span>`;
    out += chip;
    last = match.index + match[0].length;
  }
  return out + esc(text.slice(last));
}

export function composerPlaceholder({ workKind = null, inThread = false } = {}) {
  if (workKind === "request") return "What do you need?";
  if (workKind === "cancelled") return "Reason…";
  if (workKind) return "Your reply…";
  return inThread
    ? "Reply in this thread… @ to address someone"
    : "Write to the room… @ to address someone";
}

export function removeMention(text, member) {
  if (!member?.displayName) return String(text ?? "");
  const label = `@${member.displayName}`;
  const value = String(text ?? "");
  let from = 0;
  while (from <= value.length) {
    const i = value.indexOf(label, from);
    if (i === -1) return value;
    const after = value[i + label.length];
    if (after == null || /\s/.test(after)) {
      let start = i, end = i + label.length;
      const spaceBefore = start > 0 && /\s/.test(value[start - 1]);
      const spaceAfter = end < value.length && /\s/.test(value[end]);
      if (spaceBefore && spaceAfter) end += 1;
      else if (spaceBefore) start -= 1;
      else if (spaceAfter) end += 1;
      return `${value.slice(0, start)}${value.slice(end)}`;
    }
    from = i + 1;
  }
  return value;
}

export function replyAuthorToAddress(viewerId, author) {
  if (!author?.id || author.active === false || author.id === viewerId) return null;
  return author;
}

export function messageMentionsMember(body, member) {
  if (!member?.displayName) return false;
  const label = `@${member.displayName}`;
  const text = String(body ?? "");
  let from = 0;
  while (from <= text.length) {
    const i = text.indexOf(label, from);
    if (i === -1) return false;
    const after = text[i + label.length];
    if (after == null || /\s/.test(after)) return true;
    from = i + 1;
  }
  return false;
}

export function conversationIndex(messages) {
  const byId = new Map(messages.map(message => [message.id, message]));
  const rootById = new Map(), threads = new Map(), roots = [];
  for (const message of messages) {
    // Parents must already exist when a message is committed. No recursive walk is needed.
    const rootId = rootById.get(message.replyToId) || message.id;
    rootById.set(message.id, rootId);
    if (rootId === message.id) { roots.push(message); threads.set(rootId, []); }
    threads.get(rootId).push(message);
  }
  return { byId, rootById, threads, roots };
}

export function parseSearchQuery(query) {
  const raw = String(query ?? "").trim().slice(0, 200);
  const match = /^(?:mentions:me|to:me|@me)(?:\s+(.*))?$/i.exec(raw);
  if (!match) return { term: raw, mentionsOnly: false };
  return { term: (match[1] || "").trim(), mentionsOnly: true };
}

export function messageAddressesMember(message, member) {
  if (!member?.id) return false;
  if (message?.toMemberId === member.id) return true;
  return messageMentionsMember(message?.body, member);
}

// The input is the current authenticated room snapshot, never a cross-room index.
export function searchMessages(state, query, limit = 50, { viewer = null, mentionsOnly = false } = {}) {
  const parsed = parseSearchQuery(query);
  const term = parsed.term.toLocaleLowerCase();
  const only = Boolean(mentionsOnly || parsed.mentionsOnly);
  let pool = state.messages || [];
  if (only) {
    if (!viewer?.id) return { messages: [], total: 0, mentionsOnly: true };
    pool = pool.filter(message => messageAddressesMember(message, viewer));
  }
  if (!term && !only) return { messages: [], total: 0, mentionsOnly: false };
  const matches = !term ? pool : pool.filter(message =>
    message.body.toLocaleLowerCase().includes(term) ||
    (state.members[message.authorId]?.displayName || "").toLocaleLowerCase().includes(term));
  return { messages: matches.slice(-limit).reverse(), total: matches.length, mentionsOnly: only };
}

// In-memory only: every thread has its own text, recipient, reply target, retry ID,
// and submission error. Moving between discussions must not leak local composer state.
// The containing session discards the entire instance on sign-out or revoked access.
export class ConversationDrafts {
  constructor() { this.entries = new Map(); }
  get(threadId = null) {
    if (!this.entries.has(threadId)) this.entries.set(threadId, { body: "", toMemberId: "", replyToId: threadId, pending: null, error: "" });
    return this.entries.get(threadId);
  }
  save(threadId, values) { Object.assign(this.get(threadId), values); }
  clear(threadId) { this.entries.delete(threadId); }
  hasText() { return [...this.entries.values()].some(draft => draft.body.trim()); }
}

// Restore only into the same authenticated account, membership and browser session.
// Room IDs already identify the pilot's room namespace; there is no separate tenant model.
export function draftRecoveryScope(identity) {
  if (!identity?.account?.id || !Number.isInteger(identity.account.authEpoch)
    || !identity.roomId || !identity.member?.id || !identity.sessionBinding) return null;
  return JSON.stringify([identity.roomId, identity.account.id, identity.account.authEpoch,
    identity.member.id, identity.sessionBinding]);
}

// Opt-in, tab-scoped recovery. Read only after an authenticated room snapshot.
// No credentials or server receipts are stored. Browser storage is untrusted.
export class DraftRecovery {
  constructor(storage, now = Date.now) { this.storage = storage; this.now = now; this.key = "project-room:drafts:v3"; }
  clear() { try { for (const v of [1, 2, 3]) this.storage?.removeItem(`project-room:drafts:v${v}`); } catch {} }
  write(scope, drafts, threadId, activeKey = threadId) {
    try {
      if (typeof scope !== "string" || !scope) { this.clear(); return false; }
      const entries = [...drafts.entries].filter(([, d]) => d.body.trim()).slice(-50).map(([id, d]) =>
        [id, { body: d.body, toMemberId: d.toMemberId, replyToId: d.replyToId,
          ...(d.mode ? { mode: d.mode, threadId: d.threadId } : {}),
          pending: d.pending ? { id: d.pending.command.id, messageId: d.pending.command.data.messageId, contents: d.pending.contents } : null }]);
      this.storage.setItem(this.key, JSON.stringify({ scope, expires: this.now() + 12 * 60 * 60 * 1000, threadId, activeKey, entries }));
      this.storage.removeItem("project-room:drafts:v2");
      return true;
    } catch { this.clear(); return false; }
  }
  read(scope, state) {
    try {
      if (typeof scope !== "string" || !scope) { this.clear(); return null; }
      const raw = this.storage?.getItem(this.key) ?? this.storage?.getItem("project-room:drafts:v2");
      if (!raw) return null;
      if (raw.length > 500000) throw new Error("size");
      const saved = JSON.parse(raw);
      if (saved.scope !== scope || !Number.isFinite(saved.expires) || saved.expires <= this.now() || saved.expires > this.now() + 12 * 60 * 60 * 1000 || !Array.isArray(saved.entries) || saved.entries.length > 50) throw new Error("scope or expiry");
      const index = conversationIndex(state.messages), drafts = new ConversationDrafts();
      for (const [id, d] of saved.entries) {
        if (d?.mode) {
          if (!validReplyDraft(d.mode, state) || replyDraftKey(d.mode, d.threadId) !== id
            || d.threadId !== null && !index.threads.has(d.threadId)
            || typeof d.body !== "string" || d.body.length > 4000 || typeof d.toMemberId !== "string"
            || d.replyToId !== null && (!index.byId.has(d.replyToId) || index.rootById.get(d.replyToId) !== d.threadId)) continue;
          if (d.mode.kind === "request" && d.toMemberId && !state.members[d.toMemberId]) continue;
          if (d.mode.kind === "request" && d.mode.resultEventId && d.replyToId !== d.mode.resultMessageId) continue;
          if (d.mode.kind !== "request" && (d.replyToId !== d.mode.requestMessageId || d.toMemberId !== d.mode.requesterId)) continue;
          let pending = null;
          try {
            const data = replyDraftData(d.mode, { body: d.body.trim(), toMemberId: d.toMemberId || null,
              replyToId: d.replyToId, messageId: d.pending?.messageId });
            const type = d.mode.kind === "cancelled" ? "reply_request.cancelled" : "message.posted";
            const contents = JSON.stringify({ type, data, causationId: null });
            if (d.pending?.contents === contents && typeof d.pending.id === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(d.pending.id))
              pending = { contents, command: { id: d.pending.id, type, data } };
          } catch {}
          // A malformed retained operation must never become a new automatic send.
          if (d.pending && !pending) continue;
          drafts.save(id, { body: d.body, toMemberId: d.toMemberId, replyToId: d.replyToId,
            mode: d.mode, threadId: d.threadId, pending });
          continue;
        }
        if (id !== null && !index.threads.has(id)) continue;
        if (typeof d.body !== "string" || d.body.length > 4000 || typeof d.toMemberId !== "string") continue;
        if (d.toMemberId && (!state.members[d.toMemberId] || state.members[d.toMemberId].active === false)) continue;
        if (d.replyToId !== null && (!index.byId.has(d.replyToId) || index.rootById.get(d.replyToId) !== id)) continue;
        // The current client has separate command and message identities. Preserve
        // both, then recompute the entire permitted payload before accepting a retry.
        // Older saved commands without a messageId keep their original payload.
        const messageId = d.pending?.messageId;
        const messageIdValid = messageId === undefined || (typeof messageId === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(messageId));
        const data = { ...(messageId === undefined ? {} : { messageId }), body: d.body.trim(), toMemberId: d.toMemberId || null, replyToId: d.replyToId };
        const contents = JSON.stringify({ type: "message.posted", data, causationId: null });
        const pending = messageIdValid && d.pending?.contents === contents && typeof d.pending.id === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(d.pending.id)
          ? { contents, command: { id: d.pending.id, type: "message.posted", data } } : null;
        drafts.save(id, { ...data, body: d.body, toMemberId: d.toMemberId, pending });
      }
      const activeKey = drafts.entries.has(saved.activeKey) ? saved.activeKey : drafts.entries.has(saved.threadId) ? saved.threadId : null;
      return { drafts, activeKey, threadId: drafts.entries.get(activeKey)?.mode ? drafts.entries.get(activeKey).threadId : activeKey };
    } catch { this.clear(); return null; }
  }
}
