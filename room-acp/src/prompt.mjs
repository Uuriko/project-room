// Build the ACP prompt for one turn from the Room thread and the queued
// messages that woke the agent.
const MAX_CONTEXT = 12;

export function buildPrompt({ roomTitle, thread, wakes, firstTurn }) {
  const lines = [];
  if (firstTurn) {
    lines.push(`You are connected to the Project Room "${roomTitle}" through room-acp. Your reply text is posted back into the room thread. Keep replies short; the room sees your tool calls as a summary.`);
    const replies = (thread.replies ?? []).slice(-MAX_CONTEXT);
    lines.push("", "Thread so far:", `${thread.author ?? thread.authorId}: ${thread.body}`);
    for (const reply of replies) lines.push(`${reply.author ?? reply.authorId}: ${reply.body}`);
  }
  lines.push("", wakes.length > 1 ? "New messages for you:" : "New message for you:");
  for (const wake of wakes) lines.push(`${wake.author}: ${wake.body}`);
  return [{ type: "text", text: lines.join("\n").trim() }];
}
