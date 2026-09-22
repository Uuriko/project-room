/**
 * Project utilities for handling design diffs, receipts, and deltas.
 *
 * These helpers are used by the mailbox to coordinate changes between
 * agents.  They are intentionally lightweight and pure so that they can
 * be used in both Node and browser environments.
 */

import crypto from 'node:crypto';

/**
 * Compute a simple diff between two design objects.
 *
 * @param {Record<string, any>} oldDesign
 * @param {Record<string, any>} newDesign
 * @returns {Array<{ key: string, old: any, new: any }>}
 */
export function designDiff(oldDesign, newDesign) {
  const diff = [];
  const keys = new Set([...Object.keys(oldDesign ?? {}), ...Object.keys(newDesign ?? {})]);

  for (const key of keys) {
    const oldVal = oldDesign?.[key];
    const newVal = newDesign?.[key];

    // Use JSON.stringify for deep comparison; this is sufficient for
    // the simple design objects used in the project.
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      diff.push({ key, old: oldVal, new: newVal });
    }
  }

  return diff;
}

/**
 * Generate a deterministic receipt for a design object.
 *
 * The receipt is a SHA‑256 hash of the JSON stringified design.  It
 * can be used to verify that a design has not changed between
 * agents.
 *
 * @param {Record<string, any>} design
 * @returns {string} hex digest
 */
export function receipt(design) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(design));
  return hash.digest('hex');
}

/**
 * Compute a delta between two designs.
 *
 * Currently a delta is just a diff array, but the function is kept
 * separate for future extensions (e.g., patch format, versioning).
 *
 * @param {Record<string, any>} oldDesign
 * @param {Record<string, any>} newDesign
 * @returns {Array<{ key: string, old: any, new: any }>}
 */
export function delta(oldDesign, newDesign) {
  return designDiff(oldDesign, newDesign);
}
