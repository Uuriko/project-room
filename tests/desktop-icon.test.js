// The Mac app icon (scripts/build-desktop-icon.mjs): no letters, a drawing
// per size class, and every PNG build.sh packs into the .icns exists.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { iconSvg, ICON_SIZES } from "../scripts/build-desktop-icon.mjs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url));
const pngSize = path => { const b = read(path); assert.equal(b.toString("ascii", 1, 4), "PNG", path); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test("the icon is a drawing, never text, on the macOS 824px tile", () => {
  for (const size of ["large", "medium", "small"]) {
    const svg = iconSvg(size);
    assert.doesNotMatch(svg, /<text/);
    assert.match(svg, /<rect x="100" y="100" width="824" height="824" rx="185"/);
    assert.equal(read(`desktop/macos/icon/icon-${size}.svg`).toString(), svg, `${size} source is current; rerun the script`);
  }
  assert.match(iconSvg("large"), /stroke-dasharray/, "large keeps the dashed grid");
  assert.doesNotMatch(iconSvg("small"), /<line[^>]*stroke-opacity/, "small has no grid lines to blur");
});

test("every packed size exists at its exact pixel size with a transparent margin", () => {
  for (const px of Object.keys(ICON_SIZES)) {
    assert.deepEqual(pngSize(`desktop/macos/icon/icon-${px}.png`), [+px, +px]);
  }
  assert.deepEqual(Object.keys(ICON_SIZES).map(Number), [16, 32, 64, 128, 256, 512, 1024]);
});

test("build.sh packs the pre-drawn sizes instead of scaling the web icon", () => {
  const build = read("desktop/macos/build.sh").toString();
  assert.doesNotMatch(build, /icons\/icon-512\.png/);
  assert.match(build, /cp "icon\/icon-\$\{size\}\.png" "build\/ProjectRoom\.iconset\/icon_\$\{size\}x\$\{size\}\.png"/);
  assert.match(build, /cp "icon\/icon-\$\{double\}\.png" "build\/ProjectRoom\.iconset\/icon_\$\{size\}x\$\{size\}@2x\.png"/);
});
