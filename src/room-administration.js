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

// Explicit, audited opt-in for our primary development room only.
export function museDevelopmentAccess(state) {
  return state?.room?.id === 'muse-room' && state.room.developmentAccess?.enabled === true;
}
export function canInviteCoOwners(state, memberId) {
  const member = state?.members && Object.hasOwn(state.members, memberId) ? state.members[memberId] : null;
  return Boolean(member && member.active !== false && (memberId === state.room?.ownerId
    || museDevelopmentAccess(state) && member.permissions?.includes('manage_members')
      && member.permissions?.includes('decide') && member.permissions?.includes('invite_member')));
}
