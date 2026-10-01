// WCAG 2.2 AA gate for the shared design tokens. The contract job runs this
// from scripts/check.mjs, including in CI where the unit suite is skipped.
import { CONTRAST_PAIRS, contrastRatio } from "../src/design-tokens.js";

const failures = [];
for (const [name, foreground, background, min] of CONTRAST_PAIRS) {
  const ratio = contrastRatio(foreground, background);
  if (ratio < min) failures.push(`${name}: ${ratio.toFixed(2)}:1 is below ${min}:1 (${foreground} on ${background})`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`design contrast: ${CONTRAST_PAIRS.length} pairs meet WCAG 2.2 AA`);
