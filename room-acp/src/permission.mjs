// Owner approval for ACP session/request_permission, carried in the Room
// thread itself: the bridge asks in the thread, the agent's accountable
// human answers "allow" or "deny" there. No answer in time means deny.
// Fail closed: any error also denies.
export const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
const ALLOW = /^\s*(?:@\S+\s+)?(allow|approve|yes|ok)\b/i;
const DENY = /^\s*(?:@\S+\s+)?(deny|reject|no|stop)\b/i;

export function decisionOf(body) { return ALLOW.test(body) ? "allow" : DENY.test(body) ? "deny" : null; }

function pick(options, kinds) {
  for (const kind of kinds) { const option = (options ?? []).find(entry => entry.kind === kind); if (option) return option; }
  return null;
}

export class PermissionBroker {
  constructor({ room, approverId, timeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS, pollMs = 1500, log = () => {} }) {
    Object.assign(this, { room, approverId, timeoutMs, pollMs, log });
    this.pending = new Map(); // threadKey -> askMessageId
  }

  isPending(threadKey) { return this.pending.has(threadKey); }

  async request({ threadKey, toolCall, options }, signal) {
    const deny = pick(options, ["reject_once", "reject_always"]);
    const allow = pick(options, ["allow_once", "allow_always"]);
    const outcome = option => (option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } });
    if (!threadKey || !allow) return outcome(deny);
    const title = String(toolCall?.title ?? toolCall?.kind ?? "an action").replace(/\s+/g, " ").slice(0, 200);
    const minutes = Math.max(1, Math.round(this.timeoutMs / 60000));
    try {
      const { messageId } = await this.room.post({ replyToId: threadKey, body: `Permission needed: ${title}\nReply "allow" or "deny" in this thread. No answer in ${minutes} min means deny.` });
      this.pending.set(threadKey, messageId);
      const askedAt = Date.now();
      while (Date.now() - askedAt < this.timeoutMs && !signal?.aborted) {
        await new Promise(resolve => setTimeout(resolve, this.pollMs));
        const thread = (await this.room.thread(threadKey)).thread;
        const replies = thread.replies ?? [];
        const index = replies.findIndex(reply => reply.id === messageId);
        for (const reply of index >= 0 ? replies.slice(index + 1) : []) {
          if (reply.authorId !== this.approverId) continue;
          const decision = decisionOf(reply.body);
          if (decision) {
            await this.room.post({ replyToId: threadKey, body: decision === "allow" ? `Allowed: ${title}` : `Denied: ${title}` }).catch(() => {});
            return outcome(decision === "allow" ? allow : deny);
          }
        }
      }
      await this.room.post({ replyToId: threadKey, body: `No answer; denied: ${title}` }).catch(() => {});
      return outcome(deny);
    } catch (error) {
      this.log(`permission request failed closed: ${error.message}`);
      return outcome(deny);
    } finally { this.pending.delete(threadKey); }
  }
}
