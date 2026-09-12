// Room templates: whole-room presets that seed a new room's charter and
// starter work items, so agents stop assembling the same scaffolding by
// hand. Round-2 task #115. Templates are static catalog data — they carry
// no room state. The client applies them through the normal command path
// (room.charter_updated, work.proposed), so all permission gates still run.
export const ROOM_TEMPLATES = [
  {
    id: "team-standup",
    title: "Team standup",
    description: "Daily async standup: what shipped, what's next, blockers.",
    charter: {
      purpose: "Coordinate a small team's daily async standup.",
      outputs: "Each member posts what shipped, what's next, and blockers before the agreed cutoff.",
      boundaries: "Status only — decisions and design debates move to a dedicated room.",
      escalation: "Blockers older than one cycle escalate to the Room owner."
    },
    workItems: [
      { title: "Post today's standup", definitionOfDone: "Shipped / next / blockers posted in the room.", mode: "write" },
      { title: "Clear flagged blockers", definitionOfDone: "Every blocker has an owner and a next step, or is escalated.", mode: "write" }
    ],
    suggestedRoles: ["owner", "member"]
  },
  {
    id: "support-desk",
    title: "Support desk",
    description: "Triage inbound support requests with clear ownership.",
    charter: {
      purpose: "Triage and resolve inbound support requests.",
      outputs: "Every request gets an owner, a response, and a resolution or handoff.",
      boundaries: "No engineering changes happen here — bugs become work items in the owning team's room.",
      escalation: "Unresolved requests older than 24h escalate to the Room owner."
    },
    workItems: [
      { title: "Triage new requests", definitionOfDone: "Every unowned request has an owner and a first response.", mode: "write" },
      { title: "Write the weekly support summary", definitionOfDone: "Volume, top issues, and repeat-request themes posted.", mode: "write" }
    ],
    suggestedRoles: ["owner", "triage-agent", "responder"]
  },
  {
    id: "project-launch",
    title: "Project launch",
    description: "Ship-day coordination: checklist, comms, rollback plan.",
    charter: {
      purpose: "Coordinate a product launch end to end.",
      outputs: "Launch checklist completed, comms posted, rollback plan verified.",
      boundaries: "Code changes land in the repo, not in chat — this room tracks the checklist.",
      escalation: "Any red checklist item blocks launch and escalates to the Room owner."
    },
    workItems: [
      { title: "Freeze the launch checklist", definitionOfDone: "Checklist posted and acknowledged by every owner.", mode: "write" },
      { title: "Draft launch comms", definitionOfDone: "Announcement copy approved by the Room owner.", mode: "write" },
      { title: "Verify rollback plan", definitionOfDone: "Rollback steps rehearsed or reviewed; owner sign-off recorded.", mode: "write" }
    ],
    suggestedRoles: ["owner", "launch-lead", "comms"]
  },
  {
    id: "agent-swarm",
    title: "Agent swarm",
    description: "Multi-agent coordination mailbox with lanes and receipts.",
    charter: {
      purpose: "Coordinate a swarm of agents working in parallel lanes.",
      outputs: "Lane claims posted before work starts; receipts posted when work lands.",
      boundaries: "Lane owners don't touch each other's lanes without a claim handoff. Production deploys stay in the deploy lane.",
      escalation: "Lane collisions or stuck claims escalate to the Room owner."
    },
    workItems: [
      { title: "Claim lanes", definitionOfDone: "Every active agent has a posted lane claim.", mode: "write" },
      { title: "Post work receipts", definitionOfDone: "Completed work has a receipt (PR, commit, or artifact link).", mode: "write" }
    ],
    suggestedRoles: ["owner", "lane-agent"]
  }
];

export function roomTemplate(id) {
  return ROOM_TEMPLATES.find(t => t.id === id) ?? null;
}

export function roomTemplateIds() {
  return ROOM_TEMPLATES.map(t => t.id);
}
