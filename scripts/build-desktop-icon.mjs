// Mac app icon: a green wireframe cube on black, one lit cell on top.
//   node scripts/build-desktop-icon.mjs
// Writes desktop/macos/icon/icon-{16,32,64,128,256,512,1024}.png plus the
// three SVG sources. desktop/macos/build.sh packs them into the .icns.
// Three drawings, because one drawing cannot be good at both 1024 and 16 px:
//   large  (128+): 3x3 dashed grid on each face, soft glow, lit top cell
//   medium (64):   thicker edges, solid 3x3 grid, lit top cell, no glow
//   small  (16-32): heavy edges and shaded faces only; no grid to blur
// Geometry follows the macOS 11+ template: 1024 canvas, 824 rounded square
// at 100,100 with radius 185, transparent margin outside it.
// Needs Playwright's Chromium; PLAYWRIGHT_MODULE overrides the import path.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "desktop/macos/icon");
const GREEN = "#3dff8b", C = 512;
const f = n => n.toFixed(1);

function cube(R) {
  const h = R * Math.sqrt(3) / 2;
  return { T: [C, C - R], UR: [C + h, C - R / 2], LR: [C + h, C + R / 2], B: [C, C + R], LL: [C - h, C + R / 2], UL: [C - h, C - R / 2], O: [C, C] };
}
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const poly = pts => pts.map(([x, y]) => `${f(x)},${f(y)}`).join(" ");

function gridLines(o, u, v, n) {
  const lines = [];
  for (let i = 1; i < n; i++) {
    const a = lerp(o, u, i / n), b = lerp(o, v, i / n);
    lines.push([a, [a[0] + v[0] - o[0], a[1] + v[1] - o[1]]], [b, [b[0] + u[0] - o[0], b[1] + u[1] - o[1]]]);
  }
  return lines;
}

function cell(R, n, i, j) {
  const { O: o, UL: u, UR: v } = cube(R);
  const du = [(u[0] - o[0]) / n, (u[1] - o[1]) / n], dv = [(v[0] - o[0]) / n, (v[1] - o[1]) / n];
  const a = [o[0] + du[0] * i + dv[0] * j, o[1] + du[1] * i + dv[1] * j];
  return poly([a, [a[0] + du[0], a[1] + du[1]], [a[0] + du[0] + dv[0], a[1] + du[1] + dv[1]], [a[0] + dv[0], a[1] + dv[1]]]);
}

export function iconSvg(size) {
  const spec = size === "large" ? { R: 330, n: 3, edge: 24, grid: 11, dash: true, fills: [0.14, 0.08, 0.04], light: [1, 0.75, 0.5], glow: true, lit: true }
    : size === "medium" ? { R: 345, n: 3, edge: 34, grid: 14, dash: false, fills: [0.22, 0.12, 0.06], light: [1, 0.8, 0.6], glow: false, lit: true }
    : { R: 355, n: 1, edge: 60, grid: 0, dash: false, fills: [0.55, 0.28, 0.12], light: [1, 1, 1], glow: false, lit: false };
  const p = cube(spec.R);
  const faces = [[p.O, p.UL, p.T, p.UR, p.O, p.UL, p.UR], [p.O, p.UL, p.LL, p.B, p.O, p.UL, p.B], [p.O, p.UR, p.LR, p.B, p.O, p.UR, p.B]];
  const parts = faces.map((face, i) => `<polygon points="${poly(face.slice(0, 4))}" fill="${GREEN}" fill-opacity="${spec.fills[i]}"/>`);
  faces.forEach(([, , , , o, u, v], i) => {
    if (spec.n < 2) return;
    const dash = spec.dash ? ` stroke-dasharray="${Math.round(spec.grid * 1.6)} ${Math.round(spec.grid * 1.4)}"` : "";
    for (const [a, b] of gridLines(o, u, v, spec.n)) parts.push(`<line x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(b[0])}" y2="${f(b[1])}" stroke="${GREEN}" stroke-opacity="${(0.55 * spec.light[i]).toFixed(2)}" stroke-width="${spec.grid}"${dash}/>`);
  });
  parts.push(`<polygon points="${poly([p.T, p.UR, p.LR, p.B, p.LL, p.UL])}" fill="none" stroke="${GREEN}" stroke-width="${spec.edge}" stroke-linejoin="round"/>`);
  for (const end of [p.UL, p.UR, p.B]) parts.push(`<line x1="${C}" y1="${C}" x2="${f(end[0])}" y2="${f(end[1])}" stroke="${GREEN}" stroke-width="${spec.edge}" stroke-linecap="round"/>`);
  if (spec.lit) parts.push(`<polygon points="${cell(spec.R, 3, 1, 1)}" fill="${GREEN}" fill-opacity="${size === "large" ? 0.9 : 1}"/>`);
  const body = parts.join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" role="img" aria-label="Project Room">`
    + `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a0d0b"/><stop offset="1" stop-color="#000000"/></linearGradient>`
    + `<filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`
    + `<clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath></defs>`
    + `<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>`
    + `<rect x="100.5" y="100.5" width="823" height="823" rx="184.5" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width="2"/>`
    + `<g clip-path="url(#tile)"${spec.glow ? ' filter="url(#glow)"' : ""}>${body}</g></svg>\n`;
}

// Pixel size -> drawing. 16@2x is 32 px and uses the small drawing.
export const ICON_SIZES = Object.freeze({ 16: "small", 32: "small", 64: "medium", 128: "large", 256: "large", 512: "large", 1024: "large" });

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(out, { recursive: true });
  for (const size of ["large", "medium", "small"]) writeFileSync(join(out, `icon-${size}.svg`), iconSvg(size));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  const browser = await chromium.launch();
  try {
    for (const [px, drawing] of Object.entries(ICON_SIZES)) {
      const page = await browser.newPage({ viewport: { width: +px, height: +px }, deviceScaleFactor: 1 });
      await page.setContent(`<html><body style="margin:0;background:transparent">${iconSvg(drawing).replace('width="1024" height="1024"', `width="${px}" height="${px}"`)}</body></html>`);
      await page.screenshot({ path: join(out, `icon-${px}.png`), omitBackground: true, clip: { x: 0, y: 0, width: +px, height: +px } });
      await page.close();
    }
  } finally { await browser.close(); }
  console.log(`Wrote ${Object.keys(ICON_SIZES).length} PNGs and 3 SVGs to desktop/macos/icon/`);
}
