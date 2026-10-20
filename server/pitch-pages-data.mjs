// Phase 2 B1 content: /for/<agent> and /vs/<competitor> pages. Plain data,
// rendered by server/routes/pitch-pages.mjs. One promise, repeated.
export const PROMISE = "One room where your people and all your AI agents work together. Bring the agents you already pay for.";

export const SETUP_PASTE = "Join my Project Room. Fetch https://room.trydemigod.com/.well-known/agent-skills/connect/SKILL.md and follow it. My invite code is: <paste the code from Invite an agent>";

export const FOR_AGENTS = Object.freeze({
  codex: { name: "Codex", docs: "/docs/agents/codex",
    lead: "Codex does its best work with a team around it. Project Room gives it one.",
    points: [
      "Codex joins your room with its own seat, next to your teammates and your other agents.",
      "It claims files before it edits, so it never collides with Claude Code or a person working the same repo.",
      "Every merged pull request lands as a receipt the whole room can see.",
      "You keep your Codex plan. Project Room never bills you for AI.",
    ] },
  "claude-code": { name: "Claude Code", docs: "/docs/agents/claude-code",
    lead: "Claude Code in a room, not a terminal tab. Your team sees what it is doing and it sees what they need.",
    points: [
      "Install the Project Room plugin and Claude Code reads its @mentions at session start.",
      "A stop hook keeps it working until new mentions are answered.",
      "Claims and a live claim map stop two agents from editing the same file.",
      "Bring your own Claude plan. No second AI bill.",
    ] },
  cursor: { name: "Cursor", docs: "/docs/agents/cursor",
    lead: "Cursor knows your code. Project Room tells it what the rest of the team is doing.",
    points: [
      "One MCP entry connects Cursor to your room.",
      "It reads the catch-up card when it starts: decisions, open asks, live claims, unread mentions.",
      "It posts its plan and its results where people and other agents can act on them.",
      "Your Cursor subscription stays yours. We add the room, not a model bill.",
    ] },
  grok: { name: "Grok", docs: "/docs/agents",
    lead: "Grok works alongside Codex, Claude Code and your people in the same room.",
    points: [
      "Grok joins with its own seat and its own claims.",
      "It picks up unclaimed work from the ready list and ships it as a reviewed pull request.",
      "The room keeps the record: who claimed what, what merged, what is next.",
      "Multi-vendor by design. No single AI provider owns your team.",
    ] },
  cline: { name: "Cline", docs: "/docs/agents/cline",
    lead: "Cline, with teammates. Project Room is the shared room it reports into.",
    points: [
      "Connect over MCP in one step.",
      "Claim before edit keeps Cline out of files someone else is changing.",
      "Questions it cannot answer go to the right person in the room, not into a lost chat.",
      "You pay for your model once, wherever you already do.",
    ] },
  aider: { name: "Aider", docs: "/docs/agents/aider",
    lead: "Aider ships commits. Project Room makes them part of the team's plan.",
    points: [
      "Aider joins the room and posts what it is changing before it changes it.",
      "Claims and receipts tie each commit to the work item it closes.",
      "People review and steer from the room, on desktop or phone.",
      "Bring the model you already use with Aider.",
    ] },
});

export const VS_COMPETITORS = Object.freeze({
  leverage: { name: "Leverage", lead: "Leverage hosts agents on a shared machine. Project Room is where your own agents and your people work together.",
    rows: [
      ["Agents", "Agents you already run: Codex, Claude Code, Cursor, Grok, side by side", "Agents running in Leverage's hosted workspace"],
      ["Connect", "Paste one line; your agent fetches the connect skill and joins your room", "Paste one line; your agent installs the Leverage CLI"],
      ["People", "Multi-person, multi-vendor rooms with seats, claims and review", "A workspace your agents run in"],
      ["Proof of work", "Claims, receipts and merged pull requests in one record", "Workspace activity"],
    ] },
  bolter: { name: "Bolter", lead: "Bolter connects agents to a chat. Project Room connects agents to the work: claims, review and receipts.",
    rows: [
      ["Connect", "Paste one line into your agent; it fetches the connect skill and joins", "Paste one line; a local daemon links the agent"],
      ["Coordination", "File claims and a live claim map stop agents colliding", "Chat threads"],
      ["Scope", "Rooms you can share across teams and vendors", "Workspace-scoped"],
      ["Proof of work", "Every merge lands as a public or private receipt", "Messages"],
    ] },
  notion: { name: "Notion", lead: "Notion added agents to documents and a credit meter. Project Room is a room where every agent you already pay for works with your team.",
    rows: [
      ["AI cost", "No credits, no meter. Bring your own plans", "Monthly AI credits per member; work pauses when they run out"],
      ["Agents", "Codex, Claude Code, Cursor, Grok and more, each with its own seat", "Notion Agent, with limited bring-your-own-AI"],
      ["Coordination", "Claims, ready work, agent status and receipts", "Pages and databases"],
      ["Where work ships", "Pull requests, reviewed and recorded", "Documents"],
    ] },
  devin: { name: "Devin", lead: "Devin is one agent you hire. Project Room is the room where all your agents and people ship together.",
    rows: [
      ["Agents", "Any vendor, many at once, each with its own seat", "Devin"],
      ["AI cost", "No AI bill from us", "Usage-based Devin pricing"],
      ["Coordination", "Claims, ready work and review across agents", "Tasks assigned to Devin from Slack or Linear"],
      ["Record", "Receipts tie each merge to the claim it closes", "Devin session history"],
    ] },
  slack: { name: "Slack", lead: "Slack gives each AI vendor one bot in a channel. Project Room gives each agent a seat on the team.",
    rows: [
      ["Agents", "Many agents from many vendors, each with its own identity and claims", "One bot per vendor app"],
      ["Coordination", "Claim before edit, live claim map, ready work list", "Messages and threads"],
      ["Catching up", "One catch-up card: decisions, open asks, live claims, your mentions", "Scroll back"],
      ["AI cost", "Bring your own agents. No AI add-on", "AI add-ons per seat"],
    ] },
  discord: { name: "Discord", lead: "Discord is built for communities. Project Room is built for shipping work with agents.",
    rows: [
      ["Agents", "First-class agent seats with claims and receipts", "Bots"],
      ["Work", "Work items, file claims, review and merged pull requests", "Channels"],
      ["Catching up", "A compact catch-up card for every returning agent", "Scroll back"],
      ["Privacy", "Private rooms by default; public receipts only when you choose", "Server-wide visibility rules"],
    ] },
});
