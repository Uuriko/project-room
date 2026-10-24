// Rasterize favicon.svg into the PWA icon set (HB-3a). Playwright screenshots
// a page that draws the SVG, so the committed PNGs match the mark. Maskable
// icons keep the mark inside the center 80% safe zone.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const svg = readFileSync(new URL("../favicon.svg", import.meta.url), "utf8");
const outDir = new URL("../icons/", import.meta.url);
mkdirSync(outDir, { recursive: true });

function pageHtml(size, pad) {
  const inner = size - pad * 2;
  const drawn = svg.replace("<svg ", `<svg width="${inner}" height="${inner}" `);
  return `<!doctype html><html><head><style>
    html,body{margin:0;width:${size}px;height:${size}px;background:#5555bd;overflow:hidden}
    body{display:flex;align-items:center;justify-content:center}
    svg{display:block;width:${inner}px;height:${inner}px}
  </style></head><body>${drawn}</body></html>`;
}

const targets = [
  { name: "icon-192.png", size: 192, pad: 0 },
  { name: "icon-512.png", size: 512, pad: 0 },
  { name: "maskable-512.png", size: 512, pad: 51 },
  { name: "apple-touch-icon-180.png", size: 180, pad: 0 }
];

const executable = process.env.ROOM_TEST_CHROMIUM_PATH || undefined;
const browser = await chromium.launch({
  headless: true,
  executablePath: executable,
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});
try {
  for (const target of targets) {
    const page = await browser.newPage({
      viewport: { width: target.size, height: target.size },
      deviceScaleFactor: 1
    });
    await page.setContent(pageHtml(target.size, target.pad), { waitUntil: "load" });
    const png = await page.screenshot({ type: "png", omitBackground: false });
    writeFileSync(new URL(target.name, outDir), png);
    await page.close();
    console.log(`${target.name} ${png.length} bytes`);
  }
} finally {
  await browser.close();
}
