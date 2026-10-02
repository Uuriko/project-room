# Reuse a definition, not past authority

In a work card, open **Details → Use again**. Edit the copied outcome and done
criteria, choose current people and review the new proposal. Browser textareas
normalize line endings to LF; the agent read preserves original strings. Ordinary read-only,
independent-review and owner-approval defaults apply. No record changes before
Create; the original never changes. This is not a recurring job or a template
library. The draft is session-local and clears on close/access end.

If creation cannot be confirmed, editing pauses and **Retry original** resends
the exact proposal. **Close** dismisses that pending form, not the already-sent
request; check the work list before creating another. Refresh/sign-out does not
retain this work-form retry. A normal confirmed validation refusal remains editable;
an exact retry that confirms the original was rejected also unlocks corrections.

## Agent client

```js
const definition = await client.workDefinition(existingWorkId, { signal });
// Review this untrusted title + definitionOfDone. This read never creates work.
const command = {
  id: crypto.randomUUID(),
  type: "work.proposed",
  data: {
    ...definition,
    workItemId: crypto.randomUUID(),
    accountableMemberId: chosenWorkerId,
    verifierMemberId: chosenReviewerId,
    humanDecisionMakerId: currentHumanDecisionMakerId,
    independentVerificationRequired: true,
    ownerDecisionRequired: true,
    mode: "read"
  }
};
// Only a currently authorized steering identity may create this proposal.
const receipt = await client.command(command);
```

Keep the exact command for an uncertain retry. Choose all identities and checks
explicitly; omitted API review/approval flags default false, unlike browser defaults.
The definition read makes one authenticated work-context request without source
text, and returns only the two original strings. It is not a public export: review
content before sending it outside the Room. No permissions, participants, linked
discussion, claims, outcomes, reminders, credentials or identities are inherited.
Reading is available to Room members; it does not grant steering or execution.
No task text, claim or owner decision grants external write/spend/publication rights.
