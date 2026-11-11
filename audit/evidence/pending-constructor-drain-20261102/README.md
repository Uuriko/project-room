# Pending constructor proof fixture

Test-only dd0c1962b7f0aabae061f9b7ef5205e58ce84cd8 on exact a8729b406. Root full suite emitted six failures in this file; the one pending-refusal case that never calls publish passed. publish stopped at full_audit_pending and demanded one next POST return200, although protocol20 now returns202 while the report advances.

The fixture now retains the actual raw Response and uses existing completeOperatorRestore to finish actual report/publication/cleanup before its original assertions. No fake verified metadata, status rewriting, loop-bound widening or runtime change. All original message/metadata proof, deferred/eager/read-only constructor, cold retry, no-side-effects, SQL refusal, post-save fault rollback and work mutation assertions remain. Targeted7/7 pass,0skip exit0; scanexit0 and diffcheck0. No deployment or production calls.
