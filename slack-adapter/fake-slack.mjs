// FakeSlack — in-memory fake of a minimal Slack Web API subset plus an
// inbound event sink. FAKES ONLY: performs zero network I/O and never
// touches a real Slack workspace. Any token other than FAKE_TOKEN is
// rejected with invalid_auth on every method, so the fake cannot be
// mistaken for a live client.
//
// Implemented Web API subset:
//   auth.test, conversations.list, chat.postMessage, chat.update,
//   chat.delete, reactions.add, users.list
// Inbound (Events API-shaped): emitSlackEvent(event) / onInbound(fn).

export const FAKE_TOKEN = 'xoxb-fake-slack-adapter-do-not-use';
export const FAKE_TEAM = 'T-FAKE';
export const FAKE_BOT_USER = 'U-FAKE-BOT';

const ok = (data = {}) => ({ ok: true, ...data });
const fail = (error) => ({ ok: false, error });

function fakeTs(counter) {
  // Slack-shaped timestamps: seconds.microseconds, monotonically increasing.
  return `1728000000.${String(100000 + counter).slice(1)}`;
}

export class FakeSlack {
  #token;
  #seq = 0;
  #channels = new Map(); // id -> { id, name, messages: Map(ts -> message) }
  #users = new Map(); // id -> { id, name, real_name, is_bot }
  #inboundHandlers = new Set();

  constructor({ token } = {}) {
    this.#token = token;
  }

  get authed() {
    return this.#token === FAKE_TOKEN;
  }

  #guard() {
    return this.authed ? null : fail('invalid_auth');
  }

  addChannel({ id, name }) {
    if (!id || !name) throw new Error('addChannel requires id and name');
    this.#channels.set(id, { id, name, messages: new Map() });
    return this;
  }

  addUser({ id, name, real_name, is_bot = false }) {
    if (!id || !name) throw new Error('addUser requires id and name');
    this.#users.set(id, { id, name, real_name: real_name ?? name, is_bot });
    return this;
  }

  async authTest() {
    const err = this.#guard();
    if (err) return err;
    return ok({ team_id: FAKE_TEAM, user_id: FAKE_BOT_USER, bot_id: 'B-FAKE' });
  }

  async conversationsList() {
    const err = this.#guard();
    if (err) return err;
    return ok({
      channels: [...this.#channels.values()].map((c) => ({ id: c.id, name: c.name })),
    });
  }

  async usersList() {
    const err = this.#guard();
    if (err) return err;
    return ok({ members: [...this.#users.values()] });
  }

  async chatPostMessage({ channel, text, blocks, thread_ts, username } = {}) {
    const err = this.#guard();
    if (err) return err;
    const ch = this.#channels.get(channel);
    if (!ch) return fail('channel_not_found');
    if (!text && !(Array.isArray(blocks) && blocks.length)) return fail('no_text');
    this.#seq += 1;
    const ts = fakeTs(this.#seq);
    const message = {
      type: 'message',
      user: FAKE_BOT_USER,
      username: username ?? 'room-bot',
      channel,
      ts,
      thread_ts: thread_ts ?? null,
      text: text ?? '',
      blocks: blocks ?? [],
      reactions: [],
      edited: null,
    };
    ch.messages.set(ts, message);
    return ok({ channel, ts, message });
  }

  async chatUpdate({ channel, ts, text, blocks } = {}) {
    const err = this.#guard();
    if (err) return err;
    const ch = this.#channels.get(channel);
    if (!ch) return fail('channel_not_found');
    const message = ch.messages.get(ts);
    if (!message) return fail('message_not_found');
    if (text !== undefined) message.text = text;
    if (blocks !== undefined) message.blocks = blocks;
    message.edited = { ts: fakeTs(++this.#seq), user: FAKE_BOT_USER };
    return ok({ channel, ts, text: message.text, message });
  }

  async chatDelete({ channel, ts } = {}) {
    const err = this.#guard();
    if (err) return err;
    const ch = this.#channels.get(channel);
    if (!ch) return fail('channel_not_found');
    if (!ch.messages.delete(ts)) return fail('message_not_found');
    return ok({ channel, ts });
  }

  async reactionsAdd({ channel, timestamp, name } = {}) {
    const err = this.#guard();
    if (err) return err;
    const ch = this.#channels.get(channel);
    if (!ch) return fail('channel_not_found');
    const message = ch.messages.get(timestamp);
    if (!message) return fail('message_not_found');
    const existing = message.reactions.find((r) => r.name === name);
    if (existing) existing.count += 1;
    else message.reactions.push({ name, count: 1, users: [FAKE_BOT_USER] });
    return ok();
  }

  // ---- inbound (Events API-shaped) ----

  onInbound(fn) {
    this.#inboundHandlers.add(fn);
    return () => this.#inboundHandlers.delete(fn);
  }

  emitSlackEvent(event) {
    for (const fn of this.#inboundHandlers) fn(event);
  }

  // ---- inspection helpers for tests/demos ----

  messages(channel) {
    const ch = this.#channels.get(channel);
    if (!ch) return [];
    return [...ch.messages.values()].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  }

  allMessages() {
    const out = [];
    for (const ch of this.#channels.values()) out.push(...this.messages(ch.id));
    return out;
  }

  channelIds() {
    return [...this.#channels.keys()];
  }
}
