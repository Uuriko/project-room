// Builds the runtime OG assets: og/base-receipt.png, the Inter glyph atlases,
// and og/atlas.json. Playwright (a dev dependency) rasterizes Inter Regular
// from og/fonts. Re-run with `npm run build:og-atlas` after a font change.
// The marketing images in og/{home,about,offers,compare,receipts}.png are not
// written by this script.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { OG_HEIGHT, OG_WIDTH, encodePng } from "../server/og-render.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ogDir = join(root, "og");
const fontPath = join(ogDir, "fonts", "Inter-Regular.ttf");
const sizes = [48, 32, 24];
const chars = [...Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)), "…"];

function fillRect(rgba, width, x, y, w, h, color) {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(width, x + w);
  const y1 = Math.min(OG_HEIGHT, y + h);
  for (let row = y0; row < y1; row += 1) {
    for (let col = x0; col < x1; col += 1) {
      const offset = (row * width + col) * 4;
      rgba[offset] = color[0];
      rgba[offset + 1] = color[1];
      rgba[offset + 2] = color[2];
      rgba[offset + 3] = 255;
    }
  }
}

async function writeBase() {
  const rgba = new Uint8Array(OG_WIDTH * OG_HEIGHT * 4);
  fillRect(rgba, OG_WIDTH, 0, 0, OG_WIDTH, OG_HEIGHT, [0x20, 0x21, 0x27]);
  fillRect(rgba, OG_WIDTH, 0, 0, 14, OG_HEIGHT, [0x55, 0x55, 0xbd]);
  fillRect(rgba, OG_WIDTH, 48, 88, OG_WIDTH - 96, 472, [0x29, 0x2b, 0x33]);
  fillRect(rgba, OG_WIDTH, 48, 88, OG_WIDTH - 96, 8, [0xa9, 0xb9, 0xff]);
  const png = await encodePng(OG_WIDTH, OG_HEIGHT, rgba);
  writeFileSync(join(ogDir, "base-receipt.png"), png);
}

function pack(glyphs) {
  const atlasWidth = 1024;
  let rowWidth = 0;
  let rowHeight = 0;
  let height = 0;
  const placed = [];
  for (const glyph of glyphs) {
    if (glyph.w < 1 || glyph.h < 1) {
      placed.push({ ...glyph, x: 0, y: 0 });
      continue;
    }
    if (rowWidth > 0 && rowWidth + glyph.w + 1 > atlasWidth) {
      height += rowHeight + 1;
      rowWidth = 0;
      rowHeight = 0;
    }
    placed.push({ ...glyph, x: rowWidth, y: height });
    rowWidth += glyph.w + 1;
    rowHeight = Math.max(rowHeight, glyph.h);
  }
  height += rowHeight;
  const rgba = new Uint8Array(atlasWidth * Math.max(height, 1) * 4);
  const metrics = {};
  for (const glyph of placed) {
    metrics[glyph.ch] = {
      x: glyph.x,
      y: glyph.y,
      w: glyph.w,
      h: glyph.h,
      advance: glyph.advance,
      left: 0,
      top: glyph.top,
    };
    if (glyph.w < 1 || glyph.h < 1) continue;
    for (let row = 0; row < glyph.h; row += 1) {
      for (let col = 0; col < glyph.w; col += 1) {
        const src = (row * glyph.w + col) * 4;
        const dest = ((glyph.y + row) * atlasWidth + (glyph.x + col)) * 4;
        rgba[dest] = glyph.pixels[src];
        rgba[dest + 1] = glyph.pixels[src + 1];
        rgba[dest + 2] = glyph.pixels[src + 2];
        rgba[dest + 3] = glyph.pixels[src + 3];
      }
    }
  }
  return { width: atlasWidth, height: Math.max(height, 1), rgba, metrics };
}

async function rasterize() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const fontUrl = `data:font/ttf;base64,${readFileSync(fontPath).toString("base64")}`;
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      @font-face { font-family: "Inter Atlas"; src: url("${fontUrl}") format("truetype"); font-weight: 400; font-style: normal; }
      </style><canvas id="c" width="8" height="8"></canvas>`);
    await page.evaluate(async () => { await document.fonts.load('48px "Inter Atlas"'); await document.fonts.ready; });
    return await page.evaluate(({ sizes, chars }) => {
      const canvas = document.getElementById("c");
      const out = {};
      for (const size of sizes) {
        const glyphs = [];
        for (const ch of chars) {
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          ctx.font = `${size}px "Inter Atlas"`;
          const measured = ctx.measureText(ch === " " ? " " : ch);
          const advance = Math.max(1, Math.ceil(measured.width));
          if (ch === " ") {
            glyphs.push({ ch, w: 0, h: 0, advance, top: 0, pixels: [] });
            continue;
          }
          const left = Math.max(0, Math.ceil(measured.actualBoundingBoxLeft));
          const right = Math.max(1, Math.ceil(measured.actualBoundingBoxRight));
          const ascent = Math.max(1, Math.ceil(measured.actualBoundingBoxAscent));
          const descent = Math.max(0, Math.ceil(measured.actualBoundingBoxDescent));
          const w = Math.max(1, left + right + 2);
          const h = Math.max(1, ascent + descent + 2);
          canvas.width = w;
          canvas.height = h;
          const draw = canvas.getContext("2d", { willReadFrequently: true });
          draw.clearRect(0, 0, w, h);
          draw.font = `${size}px "Inter Atlas"`;
          draw.fillStyle = "#ffffff";
          draw.textBaseline = "alphabetic";
          draw.fillText(ch, left + 1, ascent + 1);
          glyphs.push({
            ch,
            w,
            h,
            advance: Math.max(advance, w),
            top: ascent + 1,
            pixels: Array.from(draw.getImageData(0, 0, w, h).data),
          });
        }
        out[size] = glyphs;
      }
      return out;
    }, { sizes, chars });
  } finally {
    await browser.close();
  }
}

const raster = await rasterize();
const atlas = {
  version: 1,
  family: "Inter",
  license: "OFL-1.1",
  font: "og/fonts/Inter-Regular.ttf",
  fontVersion: "4.1",
  sizes: {},
};
for (const size of sizes) {
  const packed = pack(raster[size].map(glyph => ({ ...glyph, pixels: Uint8Array.from(glyph.pixels) })));
  const file = `atlas-inter-${size}.png`;
  writeFileSync(join(ogDir, file), await encodePng(packed.width, packed.height, packed.rgba));
  atlas.sizes[String(size)] = {
    file,
    lineHeight: Math.ceil(size * 1.25),
    glyphs: packed.metrics,
  };
}
writeFileSync(join(ogDir, "atlas.json"), `${JSON.stringify(atlas)}\n`);
await writeBase();
console.log(`og atlas written for sizes ${sizes.join(", ")}`);
