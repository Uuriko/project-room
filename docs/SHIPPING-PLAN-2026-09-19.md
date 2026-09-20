# Project Room shipping plan and execution prompt

## Scope and release decision

Ship the complete integration in PR #717, including the main-branch work it contains, to the existing `project-room-staging` Worker serving the production room. Do not merge unrelated open PRs or change other products. John explicitly authorized push, merge, and production deployment in this session.

The current live version's draft reader cannot preserve newer channel-qualified retry commands. It is not a safe rollback target. Do not disguise a failed downgrade test as passing or remove channels to satisfy it.

The release recovery path is a retained **maintenance version**, using the same reviewed runtime with `ROOM_MAINTENANCE=1`. It returns 503 before loading the UI, opening the Durable Object store, accepting commands, or running scheduled delivery. This is an emergency stop with temporary unavailability, not a functioning older release. Resume only with the reviewed release or a qualified forward repair. The old live client remains prohibited as a post-upgrade rollback target.

## Ordered checklist

1. Verify the integration tree is clean, current with main, and exclusively claimed. Record live source/provider version and bindings; preserve namespace, migration tag, routes, origin, and secrets.
2. Add a real workerd browser regression for desktop and touch: create disposable data; commit an ordinary message and a reply request while dropping their responses; preserve original pending commands through candidate → maintenance → candidate; retry exactly, assert duplicate receipt rather than a second commit, and verify sign-out clears private drafts. Verify maintenance returns 503/no-store with no cookie or script and refuses writes. Keep the existing old-version failure documented.
3. Keep the new regression in Cloudflare CI. Run focused regression plus the Workers gate. Existing full qualification is 399 browser passes and 4,577 core passes; current PR CI must also pass all required checks without protection bypass.
4. Push the plan and test, mark PR ready, and merge the exact checked head after required CI succeeds. Do not force-push main or use the stale production branch as a deployment input.
5. Check out the merge commit for stamping and bundling. Upload a maintenance version without assigning traffic. Record its provider ID and verify its bindings explicitly include `ROOM_MAINTENANCE=1`, correct origin and existing namespace. Then upload a normal version with `ROOM_MAINTENANCE=0`, and verify those bindings. Uploads alone must not change live traffic.
6. Promote the normal immutable version to 100% traffic. Avoid a split between incompatible old/new browser versions. Do not restore a database or recreate the Durable Object.
7. Verify provider deployment and live `/api/version` name the exact merged source; `/api/ready` is ready; all public assets match the merge commit; desktop/mobile sign-in render with no script errors; unauthorized room data remains denied; getdasha.com room routes still reach the app. Authenticated synthetic journey proofs are local, not a claim of testing a real user's account.
8. If post-deployment validation fails, activate the retained maintenance version, record the failure, repair forward, and repeat verification. Never automatically return traffic to old source `7db8896`.
9. Publish final receipt with PR, merge SHA, deployed provider version, maintenance provider version, validation, limitations, and exact emergency commands. Release the coordination claim.

## Execution prompt

Continue Project Room release PR #717 in the isolated handoff-review worktree. Read this checklist and the production qualification record. Complete the real Workers pause/resume browser regression without weakening retry identity or privacy assertions. Keep the production namespace and routing unchanged. Pass protected CI, merge the checked PR, upload and verify a maintenance-only emergency version, upload the exact merged normal version, then promote normal to 100%. Verify live source/assets/readiness and browser startup. If a regression appears, pause with the retained maintenance version and fix forward; the old live client is incompatible with newer draft data. Record factual evidence and distinguish local synthetic tests from live checks. No unrelated PRs, products, provider credentials, external messages, or database replacement are in scope.

## Provider semantics

Cloudflare separates [version upload from traffic deployment](https://developers.cloudflare.com/workers/versions-and-deployments/). Worker version rollback does not restore Durable Object data. Use explicit immutable version IDs and preserve storage bindings. Recovery here intentionally stops execution before storage access rather than claiming a database rollback.

## Additional upgrade finding and repair

The exact old-live → candidate test reproduced an actual second ordinary-message command after the first send committed and its response was lost. The old writer stored channel only inside pending command contents. The new reader now recovers that field, reconstructs and validates the full permitted payload, and retains the original command. The composer preserves legacy payload shape when retrying, including omitted default-channel fields, and does not add channel metadata to a pending legacy request on re-save. Desktop/touch upgrade tests include two reloads and assert exact command identity and duplicate receipt. Current request recovery is separately covered by the real Workers pause/resume test.

GitHub's synthetic merge commit also exposed an unreliable development-test fallback selector: nearest same-schema first parent selected main, not the locally qualified checkpoint. The development package switch now pins known compatible `4a2490b` explicitly and fails closed on a future schema mismatch. It does not certify production rollback to that unuploaded checkpoint. The production emergency target remains the retained maintenance version.
