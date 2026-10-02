// Runtime Open Graph renderer (VL-1a). Dependency-free.
//
// Composites sanitized text onto og/base-receipt.png using the committed
// Inter glyph atlas (og/atlas-inter-*.png + og/atlas.json). The marketing
// images og/{home,about,offers,compare,receipts}.png belong to the static
// share set and are not written here.
//
// PNG bytes are zlib-wrapped on Node (stable for a given Node major) and
// CompressionStream("deflate") on a runtime without node:zlib. CRC32 is
// computed in JS. Text is stripped of control characters and capped at 120
// characters before it is wrapped. A title occupies at most 3 lines and the
// last line ends with an ellipsis when the rest does not fit.
import { readFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
export const OG_TEXT_LIMIT = 120;
const TITLE_SIZE = 48;
const SUBTITLE_SIZE = 32;
const SMALL_SIZE = 24;
const TEXT_X = 72;
const TEXT_MAX_WIDTH = OG_WIDTH - TEXT_X * 2;
const CONTROLS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const INK = [0xee, 0xed, 0xf1];
const MUTED = [0xaa, 0xaa, 0xb7];
const BLUE = [0xa9, 0xb9, 0xff];

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function concat(parts) {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0);
  return bytes;
}

function readU32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
}

function chunk(type, data) {
  const typeBytes = Uint8Array.from(type, char => char.charCodeAt(0));
  return concat([u32(data.length), typeBytes, data, u32(crc32(concat([typeBytes, data])))]);
}

async function deflatePng(raw) {
  if (typeof process !== "undefined" && process.versions?.node) return deflateSync(raw, { level: 1 });
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  await writer.write(raw);
  await writer.close();
  const reader = stream.readable.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return concat(parts);
}

export async function encodePng(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new TypeError("png size is invalid");
  if (!(rgba instanceof Uint8Array) || rgba.length !== width * height * 4) throw new TypeError("png buffer does not match the image size");
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const dest = y * (stride + 1);
    raw[dest] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), dest + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const compressed = await deflatePng(raw);
  const idat = compressed instanceof Uint8Array ? compressed : new Uint8Array(compressed);
  return concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array())]);
}

export function decodePng(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (input.length < 8 || PNG_SIGNATURE.some((byte, index) => input[index] !== byte)) throw new TypeError("not a png");
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset + 12 <= input.length) {
    const length = readU32(input, offset);
    const type = String.fromCharCode(input[offset + 4], input[offset + 5], input[offset + 6], input[offset + 7]);
    const data = input.subarray(offset + 8, offset + 8 + length);
    const expected = readU32(input, offset + 8 + length);
    const typeBytes = input.subarray(offset + 4, offset + 8);
    if (crc32(concat([typeBytes, data])) !== expected) throw new TypeError("png chunk crc mismatch");
    offset += 12 + length;
    if (type === "IHDR") {
      width = readU32(data, 0);
      height = readU32(data, 4);
      if (data[8] !== 8 || data[9] !== 6 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw new TypeError("unsupported png");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (width < 1 || height < 1) throw new TypeError("png is missing an image header");
  const inflated = inflateSync(concat(idat));
  const stride = width * 4;
  if (inflated.length !== (stride + 1) * height) throw new TypeError("png image data has the wrong length");
  const rgba = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    if (inflated[row] !== 0) throw new TypeError("unsupported png filter");
    rgba.set(inflated.subarray(row + 1, row + 1 + stride), y * stride);
  }
  return { width, height, rgba };
}

export function sanitizeOgText(value) {
  if (value == null) return "";
  const stripped = String(value).replace(CONTROLS, "").trim();
  return [...stripped].slice(0, OG_TEXT_LIMIT).join("");
}

function advanceOf(metrics, ch) {
  const glyph = metrics.glyphs[ch] ?? metrics.glyphs["?"];
  return glyph ? glyph.advance : 0;
}

export function wrapOgText(text, { size, maxWidth, maxLines, atlas }) {
  const sanitized = sanitizeOgText(text);
  if (!sanitized || !Number.isInteger(maxLines) || maxLines < 1) return [];
  const metrics = atlas?.sizes?.[String(size)];
  if (!metrics) throw new TypeError("unknown atlas size");
  const widthOf = line => {
    let width = 0;
    for (const ch of line) width += advanceOf(metrics, ch);
    return width;
  };
  const chars = [...sanitized];
  const lines = [];
  let index = 0;
  while (index < chars.length && lines.length < maxLines) {
    while (index < chars.length && chars[index] === " ") index += 1;
    if (index >= chars.length) break;
    const last = lines.length === maxLines - 1;
    if (!last) {
      let end = index;
      let lastBreak = -1;
      let width = 0;
      while (end < chars.length) {
        const next = width + advanceOf(metrics, chars[end]);
        if (next > maxWidth && end > index) break;
        width = next;
        if (chars[end] === " ") lastBreak = end;
        end += 1;
        if (next > maxWidth) break;
      }
      if (end >= chars.length) {
        lines.push(chars.slice(index).join("").trimEnd());
        index = chars.length;
        break;
      }
      if (lastBreak > index) {
        lines.push(chars.slice(index, lastBreak).join("").trimEnd());
        index = lastBreak + 1;
      } else {
        const cut = Math.max(index + 1, end);
        lines.push(chars.slice(index, cut).join(""));
        index = cut;
      }
      continue;
    }
    const rest = chars.slice(index).join("").replace(/\s+/gu, " ").trim();
    if (widthOf(rest) <= maxWidth) lines.push(rest);
    else {
      const budget = Math.max(0, maxWidth - widthOf("…"));
      let line = "";
      let width = 0;
      for (const ch of rest) {
        const next = width + advanceOf(metrics, ch);
        if (next > budget) break;
        line += ch;
        width = next;
      }
      lines.push(`${line.replace(/\s+$/u, "")}…`);
    }
    break;
  }
  return lines;
}

let assetsCache = null;

function loadAssets() {
  if (assetsCache) return assetsCache;
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "og");
  const atlas = JSON.parse(readFileSync(join(dir, "atlas.json"), "utf8"));
  const bitmaps = {};
  for (const [size, entry] of Object.entries(atlas.sizes)) {
    bitmaps[size] = decodePng(readFileSync(join(dir, entry.file)));
  }
  const base = decodePng(readFileSync(join(dir, "base-receipt.png")));
  if (base.width !== OG_WIDTH || base.height !== OG_HEIGHT) throw new Error("base receipt image must be 1200 by 630");
  assetsCache = { atlas, bitmaps, base: base.rgba };
  return assetsCache;
}

function blit(dst, bitmap, glyph, dx, dy, color) {
  if (!glyph || glyph.w < 1 || glyph.h < 1) return;
  const src = bitmap.rgba;
  const srcW = bitmap.width;
  for (let row = 0; row < glyph.h; row += 1) {
    const py = dy + row;
    if (py < 0 || py >= OG_HEIGHT) continue;
    for (let col = 0; col < glyph.w; col += 1) {
      const px = dx + col;
      if (px < 0 || px >= OG_WIDTH) continue;
      const si = ((glyph.y + row) * srcW + (glyph.x + col)) * 4;
      const alpha = src[si + 3];
      if (alpha === 0) continue;
      const di = (py * OG_WIDTH + px) * 4;
      const inv = 255 - alpha;
      dst[di] = (color[0] * alpha + dst[di] * inv + 127) / 255 | 0;
      dst[di + 1] = (color[1] * alpha + dst[di + 1] * inv + 127) / 255 | 0;
      dst[di + 2] = (color[2] * alpha + dst[di + 2] * inv + 127) / 255 | 0;
      dst[di + 3] = 255;
    }
  }
}

function drawLines(dst, lines, { size, x, baseline, color, atlas, bitmaps }) {
  const metrics = atlas.sizes[String(size)];
  const bitmap = bitmaps[String(size)];
  let cursorY = baseline;
  for (const line of lines) {
    let cursorX = x;
    for (const ch of line) {
      const glyph = metrics.glyphs[ch] ?? metrics.glyphs["?"];
      if (!glyph) continue;
      blit(dst, bitmap, glyph, cursorX + (glyph.left ?? 0), cursorY - glyph.top, color);
      cursorX += glyph.advance;
    }
    cursorY += metrics.lineHeight;
  }
  return cursorY;
}

export async function renderOgPng({ title = "", subtitle = "", badges = [], footer = "" } = {}) {
  const { atlas, bitmaps, base } = loadAssets();
  const rgba = new Uint8Array(base);
  const titleLines = wrapOgText(title, { size: TITLE_SIZE, maxWidth: TEXT_MAX_WIDTH, maxLines: 3, atlas });
  let y = titleLines.length
    ? drawLines(rgba, titleLines, { size: TITLE_SIZE, x: TEXT_X, baseline: 200, color: INK, atlas, bitmaps })
    : 200;
  const subtitleLines = wrapOgText(subtitle, { size: SUBTITLE_SIZE, maxWidth: TEXT_MAX_WIDTH, maxLines: 2, atlas });
  if (subtitleLines.length) {
    y = drawLines(rgba, subtitleLines, { size: SUBTITLE_SIZE, x: TEXT_X, baseline: y + 8, color: MUTED, atlas, bitmaps });
  }
  const badgeText = (Array.isArray(badges) ? badges : []).map(item => sanitizeOgText(item)).filter(Boolean).join(" · ");
  const badgeLines = wrapOgText(badgeText, { size: SMALL_SIZE, maxWidth: TEXT_MAX_WIDTH, maxLines: 1, atlas });
  if (badgeLines.length) drawLines(rgba, badgeLines, { size: SMALL_SIZE, x: TEXT_X, baseline: y + 16, color: BLUE, atlas, bitmaps });
  const footerLines = wrapOgText(footer, { size: SMALL_SIZE, maxWidth: TEXT_MAX_WIDTH, maxLines: 1, atlas });
  if (footerLines.length) drawLines(rgba, footerLines, { size: SMALL_SIZE, x: TEXT_X, baseline: 560, color: MUTED, atlas, bitmaps });
  return encodePng(OG_WIDTH, OG_HEIGHT, rgba);
}
