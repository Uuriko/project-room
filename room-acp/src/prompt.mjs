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

// A Board claim assigned to the agent. The reply is posted as a claim note.
export function buildClaimPrompt({ roomTitle, claim, author }) {
  const lines = [`You are connected to the Project Room "${roomTitle}" through room-acp. ${author ?? "Someone"} assigned you a Board claim. Do the work, then reply with a short result; it is posted as a note on the claim. Link any PR you open.`, "", `Claim ${claim.id}: ${claim.title ?? claim.id}`];
  const created = (claim.history ?? []).find(entry => entry?.action === "created");
  if (created?.note) lines.push("", created.note);
  for (const item of claim.acceptanceCriteria ?? []) lines.push(`- ${typeof item === "string" ? item : item?.text ?? ""}`);
  if (claim.repo) lines.push("", `Repo: ${claim.repo}${claim.branch ? ` (branch ${claim.branch})` : ""}`);
  return [{ type: "text", text: lines.join("\n").trim() }];
}
