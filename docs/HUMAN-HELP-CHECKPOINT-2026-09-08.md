# Human help invitation checkpoint

Previous goal turn was progress: scoped agent discovery was implemented.
Humans can now publish, edit and withdraw help requests from existing work cards.
This is local functionality, not a deployment or the completed overall goal.

## Product and implementation

- Ask for help sits inside Details for an eligible accountable member. A current
  request adds one collapsed Help wanted disclosure, with scope, end time and
  contextual Edit / End request controls. Ended invitations are no longer
  advertised to helpers; the accountable member/owner may explicitly withdraw.
- Reuses the existing work action dialog and identity-bound submission/retry
  machinery. No new page, settings panel, dependency, notification or dispatch.
  Human owner may end another member's request, not publish on their behalf.
- Scope is limited to600 characters. Duration choices are1hour,1day or7days;
  an edit may keep the current end time. The exact timestamp freezes on first
  submission, and retries never silently extend it. Expired kept times require
  a new choice. The service validates time, scope and current authority.
- Work, help and accountable-member revisions are pinned while editing. New
  scope or consent changes keep the draft and require explicit current-state
  review. The latest scope is shown alongside the retained draft. A changed
  existing expiry requires a fresh duration choice rather than retargeting it.
- Lost or mismatched save receipts retain an immutable original request. Closing
  keeps its retry; an exact retry of an old opening never reopens later withdrawn
  consent. A known stale refusal requires review before a new operation.
- Help uses the existing exact business-operation receipt verifier, without
  becoming a work-revision mutation. No assignment, completion, independent
  review, owner approval, human read marker or payment is inferred.
- The existing return clock updates expiry labels without new events. Browser
  labels use local time; agent discovery and service writes use service time.
  The label is a presentation hint, not independent execution authority.
- Scope is escaped as text, including markup-like input. The disclosure has a
  generous touch target; the dialog retains keyboard navigation and large text.

## Evidence

Nine new browser scenarios cover desktop/touch publish → actual scripted MCP
discovery → edit retaining expiry → withdrawal; stale scope comparison; a real
server-side race/refusal; lost and mismatched receipts; close/exact retry after
withdrawal; expiry without new events; owner/guest boundaries; keyboard,
enlarged text and publishing-permission loss with draft preservation.

- 627 core/API/package checks pass on final source. Receipt tests now cover help
 changes while explicitly asserting unchanged work revision.
- 193 full browser checks pass. That run began before the final container-scoped
 lookup correction; all13 affected help/contribution journeys were rerun and pass
 on the final source. No broader claim is based only on those13 checks.
- 15 local Workers regressions pass. Service/storage semantics are unchanged;
 historical8/12 switch checks are not schema13 fallback qualification.

The first core run caught a static hook assertion: help comparison text is created
inside the action form, not present in initial HTML. Its lookups now explicitly
use that form container, matching its actual lifetime. The assertion was not
weakened. The failed log is retained separately. Test fixture corrections included
waiting for asynchronous comparison rendering, using the real sign-out control
and setting the browser's enlarged-text style without changing the application CSP.

Four final screenshots were inspected (publish/open, desktop/touch). Two JSON
records identify simulated humans, actual scripted MCP and tested human controls.
The earlier contribution scenario now uses helpInvitationUITested:false because
it tests event replay, not human controls; this is not a claim that UI is absent.
No native-model reasoning or real-human retention conclusions are claimed.

## Frozen package

Runtime61f12941e0b195487a3718451725e78cf444675b,
tree909a798092531ace9c6b39202cb6a9a39e35118e, schema13,67files,20assets:
`../project-room-runtime-packages-20260908/human-help-61f1294`.
Manifest SHA256:
`d24cb466a990547513f7092905f9140f1d190a32fd8d75ab826ece787d30fd57`.
All current runtime file hashes match. Eleven evidence files (five logs, four
screenshots, two JSON) are in sibling `evidence-human-help`. Test processes ended.

## Next

1. Bind offers to the exact active invitation, scope and consent. Reuse canonical
   reply/discussion where possible, but do not infer a typed offer from prose.
2. Limit outstanding/repeated offers, reconcile simultaneous helpers and define
   decline/cancel/withdrawal behavior. Preserve independent reviewer separation.
3. Test returning human choice and explicit contributions through the same work.
   Existing discussion and drafts remain useful but are not invitation-bound.
4. Qualify a distinct schema13-compatible fallback on populated state and
   hosted/current-authority recovery before publication. Preserve historical
   packages; schema12 fallback is not compatible with13 data.

No push, deployment, live migration, paid models, provider operation, existing
preview restart or external work was performed. Overall goal remains active.
