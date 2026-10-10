// Render every brand asset from one source: the mark below.
//   node scripts/build-brand-assets.mjs
// Writes favicon.svg, icon.svg, brand/mark-mono.svg, icons/*.png and the
// static og/*.png share images. Needs Playwright's Chromium (dev dependency).
// PLAYWRIGHT_MODULE overrides the import path when Playwright lives elsewhere.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { iconSvg } from "./build-desktop-icon.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BG = "#202127", TEXT = "#eeedf1", MUTED = "#aaaab7";

// The mark is the green wireframe cube from scripts/build-desktop-icon.mjs,
// so the Mac app, the browser tab and the home-screen icon are one drawing.
// Each place picks the drawing made for its pixel size.
const drawingFor = px => px <= 48 ? "small" : px <= 96 ? "medium" : "large";
const sized = (svg, px) => svg.replace('width="1024" height="1024"', `width="${px}" height="${px}"`);
export const MARK_SVG = iconSvg("small", { mode: "square" });
// One colour, no tile: outline, the three front edges and lightly shaded faces.
export const MARK_MONO_SVG = (() => {
  const h = 12 * Math.sqrt(3) / 2, c = 16, n = v => v.toFixed(2);
  const T = [c, c - 12], UR = [c + h, c - 6], LR = [c + h, c + 6], B = [c, c + 12], LL = [c - h, c + 6], UL = [c - h, c - 6], O = [c, c];
  const pts = list => list.map(([x, y]) => `${n(x)},${n(y)}`).join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true">`
    + `<polygon points="${pts([O, UL, T, UR])}" fill="currentColor" fill-opacity=".4"/>`
    + `<polygon points="${pts([O, UL, LL, B])}" fill="currentColor" fill-opacity=".2"/>`
    + `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><polygon points="${pts([T, UR, LR, B, LL, UL])}"/><path d="M${n(c)} ${n(c)}L${n(UL[0])} ${n(UL[1])}M${n(c)} ${n(c)}L${n(UR[0])} ${n(UR[1])}M${n(c)} ${n(c)}L${n(B[0])} ${n(B[1])}"/></g></svg>\n`;
})();

const OG_PAGES = {
  home: ["Work with your agents in one room.", "People and AI agents in one conversation, with one record of the work."],
  about: ["Give an agent work. See what comes back.", "Talk it through with your team, and keep the result."],
  offers: ["Work that needs doing", "Tasks rooms have posted for people and agents to pick up."],
  compare: ["Built for people and agents", "How Project Room differs from Slack, Discord and other tools."],
  receipts: ["Finished work, with proof", "Each receipt shows what was done and who checked it."],
};

const font = pathToFileURL(join(root, "og/fonts/Inter-Regular.ttf")).href;
const page = (body, w, h, bg = "transparent") => `<!doctype html><html><head><style>
@font-face{font-family:InterBundled;src:url("${font}")}
html,body{margin:0;width:${w}px;height:${h}px;background:${bg};overflow:hidden}
body{font-family:"Inter Display",Inter,InterBundled,sans-serif;-webkit-font-smoothing:antialiased}
svg{display:block}</style></head><body>${body}</body></html>`;

const tile = size => sized(iconSvg(drawingFor(size), { mode: "square" }), size);
const fullBleed = size => sized(iconSvg(drawingFor(size), { mode: "bleed" }), size);
// Lockup top left, one headline, nothing else.
const og = ([headline, sub]) => `<div style="position:relative;width:1200px;height:630px;background:${BG};color:${TEXT};overflow:hidden">
<div style="position:absolute;left:88px;top:80px;display:flex;align-items:center;gap:22px">${tile(76, 8)}<span style="font-size:42px;font-weight:600;letter-spacing:-.03em">Project Room</span></div>
<div style="position:absolute;left:88px;top:248px;width:760px;display:flex;flex-direction:column;gap:26px">
<div style="font-size:72px;font-weight:600;line-height:1.05;letter-spacing:-.04em;text-wrap:balance">${headline}</div>
<div style="width:700px;font-size:30px;line-height:1.35;color:${MUTED};letter-spacing:-.01em;text-wrap:pretty">${sub}</div>
</div>
</div>`;

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch();
async function render(html, w, h, out, transparent = false) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.setContent(html, { waitUntil: "load" });
  await p.evaluate(() => globalThis.document.fonts.ready);
  mkdirSync(dirname(join(root, out)), { recursive: true });
  await p.screenshot({ path: join(root, out), omitBackground: transparent, type: "png" });
  await p.close();
}
try {
  writeFileSync(join(root, "favicon.svg"), MARK_SVG);
  writeFileSync(join(root, "icon.svg"), MARK_SVG);
  mkdirSync(join(root, "brand"), { recursive: true });
  writeFileSync(join(root, "brand/mark-mono.svg"), MARK_MONO_SVG);
  await render(page(tile(512, 7), 512, 512), 512, 512, "icons/icon-512.png", true);
  await render(page(tile(192, 7), 192, 192), 192, 192, "icons/icon-192.png", true);
  await render(page(fullBleed(512, 0.62)), 512, 512, "icons/maskable-512.png");
  await render(page(fullBleed(180, 0.74)), 180, 180, "icons/apple-touch-icon-180.png");
  for (const [name, copy] of Object.entries(OG_PAGES)) await render(page(og(copy), 1200, 630, BG), 1200, 630, `og/${name}.png`);
} finally {
  await browser.close();
}
console.log("Wrote favicon.svg, icon.svg, brand/mark-mono.svg, 4 icons, " + Object.keys(OG_PAGES).length + " share images.");
