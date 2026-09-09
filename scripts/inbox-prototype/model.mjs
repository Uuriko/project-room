// U04 design state only. No provider, credentials, persistence or access control.
// Do not use this fixture as a production private-messaging service.
export class InboxPreview {
  constructor() {
    this.threads = [
      { id: "launch", channel: "Email", from: "Maya Chen", address: "maya@example.test", account: "you@example.test",
        subject: "A small launch next week", revision: 1, paragraphs: [
          "Could your team put together a short launch note? We'd love something warm, clear and ready by Thursday.",
          "The room can suggest a first paragraph and a simple next step.",
          "Private planning note: our internal budget is 4,200. Please keep this between us."
        ] },
      { id: "coffee", channel: "Email", from: "Sam Rivera", address: "sam@example.test", account: "you@example.test",
        subject: "Coffee on Friday?", revision: 1, paragraphs: ["Are you around Friday morning? It would be lovely to catch up."] },
      { id: "studio", channel: "Chat", from: "Iris Park", address: "iris.sample", account: "Your sample chat",
        subject: "A reference for the studio", revision: 1, paragraphs: ["The quieter layout feels right. Can we keep the conversation at the center?"] }
    ];
    this.messages = [{ id: "hello", by: "Alex", kind: "chat", body: "A place for our launch notes. Bring a question, or just say hello." }];
    this.drafts = new Map(); this.operations = new Map(); this.shared = new Map();
    this.room = { id: "launch-room", title: "Launch studio", people: ["You", "Alex", "Rin · agent"] };
  }
  thread(id) {
    const thread = this.threads.find(t => t.id === id);
    if (!thread) throw new Error("Choose a conversation.");
    return thread;
  }
  draft(key) { return this.drafts.get(key) ?? ""; }
  setDraft(key, body) { this.drafts.set(key, body); }
  shareTicket(id) { const t = this.thread(id); return { threadId: t.id, revision: t.revision, roomId: this.room.id }; }
  share(ticket, indexes, id) {
    const thread = this.thread(ticket.threadId);
    if (ticket.revision !== thread.revision || ticket.roomId !== this.room.id) throw new Error("Source changed. Review the current message.");
    if (!Array.isArray(indexes) || !indexes.length || new Set(indexes).size !== indexes.length
      || indexes.some(i => !Number.isInteger(i) || !thread.paragraphs[i])) throw new Error("Choose text to share.");
    const body = indexes.map(i => thread.paragraphs[i]).join("\n\n");
    const payload = JSON.stringify({ ...ticket, indexes, body });
    const previous = this.shared.get(id);
    if (previous) {
      if (previous.payload !== payload) throw new Error("This sharing attempt already has different text.");
      return this.messages.find(m => m.id === id);
    }
    const message = { id, by: "You", kind: "excerpt", body, label: thread.channel + " excerpt" };
    this.messages.push(message); this.shared.set(id, { payload, threadId: thread.id });
    return message;
  }
  roomView() { return structuredClone({ room: this.room, messages: this.messages }); }
  postChat(body, id) {
    if (typeof body !== "string" || !body.trim() || body.length > 4000) throw new Error("Write a message of up to 4,000 characters.");
    this.messages.push({ id, by: "You", kind: "chat", body });
    this.setDraft("room", "");
  }
  reply(command, behavior = "normal") {
    const { id, threadId, revision, body, to, from } = command, thread = this.thread(threadId);
    const previous = this.operations.get(id);
    if (previous) {
      if (JSON.stringify(previous.command) !== JSON.stringify(command)) throw new Error("Reply attempt changed.");
      return previous.receipt;
    }
    if (revision !== thread.revision || to !== thread.address || from !== thread.account) throw new Error("Conversation changed. Review before sending.");
    if (!body.trim() || body.length > 4000) throw new Error("Write a reply of up to 4,000 characters.");
    if (behavior === "offline") throw new Error("Sample connection unavailable. Your draft is kept.");
    const receipt = { id, status: "sample_recorded", delivered: false };
    this.operations.set(id, { command: structuredClone(command), receipt });
    if (behavior === "lost") return null;
    return receipt;
  }
  reconcile(id) { return this.operations.get(id)?.receipt ?? null; }
}
