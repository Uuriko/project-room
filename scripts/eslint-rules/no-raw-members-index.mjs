// ESLint rule: no raw indexing into a room's members map.
//
// Indexing `state.members[someId]` with a caller-supplied id resolves
// inherited Object.prototype members for ids like "toString" or
// "constructor" — a phantom member that satisfies truthiness and property
// reads (the #2842/#3006/#3007/#3009/#3023 bug family). Every member lookup
// must go through ownMember(members, id) from src/events.js, which guards
// with Object.hasOwn and returns undefined for absent or prototype ids.
//
// The rule flags a computed member access whose object is a `.members`
// property access (or an identifier named `members`):
//   state.members[id]            flagged
//   room.state.members[id]       flagged
//   authority.members[id]?.x     flagged
//   members[id]                  flagged
// It does not flag:
//   ownMember(state.members, id) a call, not an index
//   Object.hasOwn(members, id)   a guard call, not an index
//   state.members                a bare property read
//   state.workItems[id]          a different map — not this rule's concern
//
// Enforcement is a ratchet (see RAW_MEMBERS_INDEX_ENFORCED in
// eslint.config.mjs): warn everywhere in server/** so the burn-down stays
// visible, error in migrated files. Burn-down tracker: issue #3224.
export const noRawMembersIndex = {
  meta: {
    type: "problem",
    docs: { description: "disallow raw indexing into a members map; use ownMember(members, id) from src/events.js" },
    schema: [],
    messages: { raw: "Raw members index. Resolve members through ownMember(members, id) from src/events.js so prototype ids (\"toString\", \"constructor\", …) cannot pose as members." },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (!node.computed) return;
        const obj = node.object;
        const isMembers = obj.type === "Identifier"
          ? obj.name === "members"
          : obj.type === "MemberExpression" && (obj.computed
            ? obj.property.type === "Literal" && obj.property.value === "members"
            : obj.property.type === "Identifier" && obj.property.name === "members");
        if (isMembers) context.report({ node, messageId: "raw" });
      },
    };
  },
};

export default { rules: { "no-raw-members-index": noRawMembersIndex } };
