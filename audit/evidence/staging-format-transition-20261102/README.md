# Exact unused format5 control transition

Staging run41413367099 uploaded8c1c2bd45 but room-backed smoke returned503. Live tail captured ProjectRoom constructor -> RoomStore.restoreStatus -> verifyRestoreControl: `Restore admission schema requires reconciliation`. No production changes.

Source2c6a83ce8 reproduces against actual prior deployed8e65a6e73 and admits only the complete, exact format5 definitions with no normalized head/record/proof/scratch rows, a closed writer permit, and clear restore admission. Seven format-bound triggers change in one transaction. Legacy rooms, accounts, account-session bindings and credentials remain unchanged. Unknown schema, pending restore, and populated normalized data refuse; this is not a populated format5 migration.

Five Node tests cover genuine historical-source startup, account/session/key continuity, populated/drift/pending refusal and interrupted-DDL rollback/retry. Twelve including schema-stamp checks pass. A synthetic prior-control Native Worker cold restart passes; the genuine historical-source test uses Node SQLite. Composed source with browser read reuse passes26checks. Live staging recovery remains unverified until a new deployment and smoke finish.
