// SlackBot — prototype runtime wiring Project Room events to Slack-style
// messages through the fake Slack API. All dependencies are injected:
//   - fake:   FakeSlack instance (never a live client)
//   - roomSource: async iterable (or EventEmitter with 'event') of room events
//   - roomSink:  fn(command) receiving room commands derived from Slack input
//   - channel:   Slack channel id to post into
//   - directory: Map<roomActorId, { slackId, displayName }>
//
// Behavior: dedupes room events by event id, maps each via roomEventToSlack,
// posts to the fake, and records roomEventId -> Slack ts in a thread map so
// room replies land in the right Slack thread. Inbound Slack events become
// room commands via slackEventToRoom. Nothing is ever sent over the network.

import { roomEventToSlack } from './event-map.mjs';
import { slackEventToRoom } from './inbound-map.mjs';
import { FAKE_BOT_USER } from './fake-slack.mjs';

export class SlackBot {
  #fake;
  #roomSource;
  #roomSink;
  #channel;
  #directory;
  #seen = new Set();
  #threadMap = new Map();
  #unsubscribes = [];
  #stats = { roomEvents: 0, posted: 0, fallbacks: 0, skipped: 0, inbound: 0, inboundIgnored: 0 };

  constructor({ fake, roomSource, roomSink, channel, directory } = {}) {
    if (!fake) throw new Error('SlackBot requires a fake Slack instance');
    if (typeof roomSink !== 'function') throw new Error('SlackBot requires a roomSink function');
    if (!channel) throw new Error('SlackBot requires a channel');
    this.#fake = fake;
    this.#roomSource = roomSource ?? null;
    this.#roomSink = roomSink;
    this.#channel = channel;
    this.#directory = directory ?? new Map();
  }

  ctx() {
    return { channel: this.#channel, threadMap: this.#threadMap, directory: this.#directory };
  }

  stats() {
    return { ...this.#stats };
  }

  async handleRoomEvent(event) {
    this.#stats.roomEvents += 1;
    if (!event || this.#seen.has(event.id)) {
      this.#stats.skipped += 1;
      return null;
    }
    this.#seen.add(event.id);
    const payload = roomEventToSlack(event, this.ctx());
    const res = await this.#fake.chatPostMessage({
      channel: payload.channel,
      text: payload.text,
      blocks: payload.blocks,
      thread_ts: payload.thread_ts,
    });
    if (!res.ok) throw new Error(`fake chat.postMessage failed: ${res.error}`);
    this.#threadMap.set(event.id, res.ts);
    this.#stats.posted += 1;
    if (payload._meta.mappedAs === 'fallback') this.#stats.fallbacks += 1;
    return { slackTs: res.ts, payload };
  }

  async handleInbound(envelope) {
    this.#stats.inbound += 1;
    const command = slackEventToRoom(envelope, { botUserId: FAKE_BOT_USER, channel: this.#channel });
    if (!command) {
      this.#stats.inboundIgnored += 1;
      return null;
    }
    await this.#roomSink(command);
    return command;
  }

  start() {
    const off = this.#fake.onInbound((envelope) => {
      this.handleInbound(envelope).catch(() => {});
    });
    this.#unsubscribes.push(off);

    if (this.#roomSource) {
      if (typeof this.#roomSource[Symbol.asyncIterator] === 'function') {
        const pump = (async () => {
          for await (const event of this.#roomSource) {
            try { await this.handleRoomEvent(event); } catch { /* keep pumping */ }
          }
        })();
        this.#unsubscribes.push(() => {});
        void pump;
      } else if (typeof this.#roomSource.on === 'function') {
        const listener = (event) => { this.handleRoomEvent(event).catch(() => {}); };
        this.#roomSource.on('event', listener);
        this.#unsubscribes.push(() => this.#roomSource.off?.('event', listener));
      }
    }
    return this;
  }

  stop() {
    for (const off of this.#unsubscribes.splice(0)) { try { off(); } catch { /* noop */ } }
  }
}
