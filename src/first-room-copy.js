// Copy for the account rooms panel when the automatic first-room setup
// fails. A failed setup must read as a failure with a retry — never as the
// "No rooms yet." empty state, which hides a real failure behind a false
// empty panel with no next step. "Choose Rooms" is a genuine retry: the
// Rooms navigation re-runs loadAccountRooms(), which re-runs the setup.
export const FIRST_ROOM_SETUP_FAILURE =
  "Couldn\u2019t set up your first room. Choose Rooms to retry.";
