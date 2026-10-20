// Synthetic research material only. No accounts, tokens or production content.
export const variants = ['conversation', 'split', 'work'];
export const scenarios = [
  {
    id: 'writing', title: 'Launch announcement', owner: 'Mina',
    brief: 'Prepare a public announcement from the work already in progress.',
    blocker: 'Confirm the release date',
    versions: [
      { id: 'launch-1', label: 'Earlier accepted draft', body: 'Atlas launches November 4. Contact Mina for details.' },
      { id: 'launch-2', label: 'Latest proposal — awaiting review', body: 'Atlas launches November 12. Contact Mina for details.' }
    ],
    messages: [
      ['Mina', 'The first draft is accepted as our starting point, not approved for publication.'],
      ['Theo', 'The planning meeting moved to Thursday.'],
      ['Agent A', 'I have submitted launch-2 as the latest proposal.'],
      ['Mina', 'I own this announcement. Confirm the release date before publishing.'],
      ['Theo', 'The product name and audience are unchanged.'],
      ['Mina', 'Correction: the release is November 21. Keep Mina as the contact.']
    ]
  },
  {
    id: 'analysis', title: 'Activation analysis', owner: 'Ravi',
    brief: 'Finish the activation summary for the team.', blocker: 'Confirm the eligible cohort',
    versions: [
      { id: 'analysis-1', label: 'Earlier accepted draft', body: 'Activation is 60% (60 of 100 eligible accounts). Analyst: Ravi.' },
      { id: 'analysis-2', label: 'Latest proposal — awaiting review', body: 'Activation is 80% (80 of 100 eligible accounts). Analyst: Ravi.' }
    ],
    messages: [
      ['Ravi', 'The earlier summary is our accepted starting point.'],
      ['Lea', 'The chart colors can wait until the figures are settled.'],
      ['Agent A', 'analysis-2 is the latest proposal; it still needs review.'],
      ['Ravi', 'I own this analysis. Confirm the eligible cohort before sharing.'],
      ['Lea', 'The board meeting is next week.'],
      ['Ravi', 'Correction: exclude test accounts. The eligible cohort is 80, and 60 activated: 75%. Keep the counts and Ravi in the summary.']
    ]
  },
  {
    id: 'coding', title: 'Retry policy', owner: 'Nora',
    brief: 'Finish the retry-policy specification before implementation.', blocker: 'Confirm which failures may retry',
    versions: [
      { id: 'retry-1', label: 'Earlier accepted draft', body: 'Retry GET requests once on 503. Owner: Nora.' },
      { id: 'retry-2', label: 'Latest proposal — awaiting review', body: 'Retry every request three times on any failure. Owner: Nora.' }
    ],
    messages: [
      ['Nora', 'The earlier policy is an accepted starting point, not a deployed change.'],
      ['Sam', 'The local test server is available.'],
      ['Agent A', 'retry-2 is the latest proposal awaiting review.'],
      ['Nora', 'I own this change. Confirm which failures may retry before implementation.'],
      ['Sam', 'We can clean up the command names afterward.'],
      ['Nora', 'Correction: retry GET requests at most twice, only on 503; never retry POST. Keep Nora as owner.']
    ]
  }
];
export function scenario(id) {
  const value = scenarios.find(item => item.id === id);
  if (!value) throw new Error('Unknown scenario');
  return value;
}
export function contextPacket(s, mode) {
  if (!['full', 'compact', 'retrievable'].includes(mode)) throw new Error('Unknown context mode');
  const common = { task: s.brief, currentVersion: s.versions[1].id, owner: s.owner, result: s.versions[1].body };
  if (mode === 'full') return { ...common, messages: s.messages, versions: s.versions };
  // Deliberately stale compact summary: this is an information-loss control.
  return { ...common, warning: 'Summary may omit later discussion.', ...(mode === 'retrievable'
    ? { read: `/api/scenario/${s.id}/discussion`, instruction: 'Read later discussion before submitting a continuation.' } : {}) };
}
