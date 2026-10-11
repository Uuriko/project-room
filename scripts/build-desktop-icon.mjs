// Rasterize the canonical web mark for native iconutil; no app rebuild or install.
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const svg = readFileSync(new URL("../project-room-mark.svg", import.meta.url), "utf8");
const browser = await chromium.launch({ headless: true, executablePath: process.env.ROOM_TEST_CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:1024px;height:1024px}</style>${svg}`);
  writeFileSync(new URL("../desktop/macos/ProjectRoom.png", import.meta.url), await page.screenshot({ type: "png", omitBackground: true }));
} finally {
  await browser.close();
}
