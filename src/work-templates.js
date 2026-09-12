// Work-item templates: common job shapes agents can start from instead of
// assembling a work.proposed payload by hand. Round-2 task #103.
// Templates are static catalog data — they carry no room state.
export const WORK_TEMPLATES = [
  {
    id: "compute-job",
    title: "Compute job",
    description: "Run a bounded compute task on a provider Mac and report results.",
    work: {
      title: "[compute] <one-line summary>",
      definitionOfDone: "Result payload posted on the work item; input data archived or deleted per the job's retention note.",
      mode: "agent",
      suggestedCapabilities: ["compute", "mac-runner"],
      suggestedFields: ["command", "timeoutMinutes", "inputRef", "expectedOutput"]
    }
  },
  {
    id: "code-review",
    title: "Code review",
    description: "Review a branch or PR for correctness, tests, and contract fit.",
    work: {
      title: "[review] <branch or PR>",
      definitionOfDone: "Verdict posted (approve / request changes) with specific findings; blocking issues linked to follow-up work.",
      mode: "agent",
      suggestedCapabilities: ["code-review", "testing"],
      suggestedFields: ["ref", "scope", "contractNotes"]
    }
  },
  {
    id: "outreach",
    title: "Outreach",
    description: "Contact an external prospect or partner about a concrete ask.",
    work: {
      title: "[outreach] <who and what>",
      definitionOfDone: "Message sent or draft staged for human approval; reply status recorded on the work item.",
      mode: "human-approval",
      suggestedCapabilities: ["outreach", "research"],
      suggestedFields: ["prospect", "channel", "draftRef", "approvalRequired"]
    }
  },
  {
    id: "research",
    title: "Research",
    description: "Investigate a question and return a sourced summary.",
    work: {
      title: "[research] <question>",
      definitionOfDone: "Summary posted with sources; open questions listed for follow-up.",
      mode: "agent",
      suggestedCapabilities: ["research", "web-search"],
      suggestedFields: ["question", "sources", "deadline"]
    }
  },
  {
    id: "bug-fix",
    title: "Bug fix",
    description: "Reproduce, fix, and regression-test a reported bug.",
    work: {
      title: "[bug] <symptom>",
      definitionOfDone: "Reproduction confirmed, fix merged with a regression test, and the fix verified in CI.",
      mode: "agent",
      suggestedCapabilities: ["debugging", "testing"],
      suggestedFields: ["repro", "affectedVersion", "fixRef"]
    }
  }
];

export function workTemplate(id) {
  return WORK_TEMPLATES.find(t => t.id === id) ?? null;
}

export function workTemplateIds() {
  return WORK_TEMPLATES.map(t => t.id);
}
