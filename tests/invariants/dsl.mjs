// Invariant scenario DSL: declare -> act -> assert.
//
// An invariant pins a never-break product property: "retry must not
// duplicate work", "failed actions preserve data", "a release requires
// the holder's claim", ... The DSL keeps the three phases visually
// separate so a reader can see the invariant at a glance:
//
//   import { invariant } from "./dsl.mjs";
//   import { invariantSuite } from "./runner.mjs";
//
//   invariantSuite([
//     invariant("retry-no-duplicate", "retry of a confirmed action is a no-op")
//       .given((f, ctx) => { /* declare preconditions; return extra ctx */ })
//       .when(async (f, ctx) => { /* act: perform the operation(s) */ })
//       .then(async (f, ctx) => { /* assert: pin the invariant */ })
//       .build(),
//   ]);
//
// Phase rules:
// - given: builds the world (identities, rooms, work items, claims).
//   Must not perform the operation under test.
// - when: performs exactly the operation(s) the invariant covers. May
//   throw when the operation is refused — refusal IS the test signal.
// - then: asserts the invariant holds. Receives the thrown error (if
//   any) as ctx.error. No new state changes here.
//
// The builder writes fail-first friendly code: if you have not seen
// this test fail red against a deliberately broken build, it is not
// done.

export function invariant(id, title = "untitled") {
  if (typeof id !== "string" || !id) throw new Error("invariant() requires a non-empty id");
  const scenario = { id, title };
  const api = {
    given(fn) {
      if (typeof fn !== "function") throw new Error(`invariant ${id}: given() requires a function`);
      scenario.arrange = fn;
      return api;
    },
    when(fn) {
      if (typeof fn !== "function") throw new Error(`invariant ${id}: when() requires a function`);
      const inner = scenario.act;
      scenario.act = async (f, ctx) => {
        if (inner) await inner(f, ctx);
        try {
          return await fn(f, ctx);
        } catch (err) {
          ctx.error = err;
          return ctx;
        }
      };
      return api;
    },
    then(fn) {
      if (typeof fn !== "function") throw new Error(`invariant ${id}: then() requires a function`);
      scenario.assert = fn;
      return api;
    },
    build() {
      return { ...scenario };
    },
  };
  return api;
}

// Validate a scenario object before it reaches the runner. Exported so
// suite files can self-check in a cheap unit test.
export function validateScenario(scenario) {
  const problems = [];
  if (!scenario || typeof scenario.id !== "string" || !scenario.id) problems.push("missing non-empty string id");
  if (scenario && typeof scenario.assert !== "function") problems.push("missing assert(f, ctx) phase");
  return problems;
}
