// Per-room design upgrade. muse-room is on until an owner turns it off.
// Every other room stays off until an owner turns it on.
export const DESIGN_UPGRADE_FLAG = "designUpgrade";

export const DESIGN_UPGRADE_DEFAULT_ROOMS = Object.freeze(["muse-room"]);

export function designUpgradeDefault(roomId) {
  return DESIGN_UPGRADE_DEFAULT_ROOMS.includes(roomId);
}

export function designUpgradeEnabled(roomId, stored) {
  if (stored === true || stored === 1) return true;
  if (stored === false || stored === 0) return false;
  return designUpgradeDefault(roomId);
}
