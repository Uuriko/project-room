// Work claims (B006/B007). A pure work-item state machine for agent
// coordination: work starts unclaimed; an agent claims it (claimed), starts
// it (in_progress), and finishes it (done) or marks it blocked. Only the
// claiming agent may update, release, or reassign its work — anyone else's
// attempt is refused, never half-applied. This is the anti-collision core:
// two agents cannot both own the same work item. Pure, dependency-free,
// deterministic; frozen outputs. Persistence is a later slice.
