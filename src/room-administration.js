// One authorization rule for routine room administration in UI and server.
// Membership must be current; a delegated marker without the permission is inert.
export function canAdministerRoom(state, memberId) {
  const member = state?.members && Object.hasOwn(state.members, memberId) ? state.members[memberId] : null;
  return Boolean(member && member.active !== false && (
    memberId === state.room?.ownerId
    || member.permissions?.includes('manage_members')
      && (member.kind === 'human' || member.delegatedAdmin === true)
  ));
}
