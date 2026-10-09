// Shared boot/teardown for the Variant-A browser checks: a disposable
// acceptance fixture, a local room HTTP server, and headless Chromium with a
// standard page-error collector. boot(t, opts) reproduces the inline
// boilerplate the checks used to duplicate; assertions live in the checks.
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

/**
 * Boot a disposable browser-check world and register its teardown on t.
 *
 * @param {import("node:test").TestContext} t the test context (teardown hooks)
 * @param {object} [opts]
 * @param {object} [opts.fixture={}] extra options for createAcceptanceFixture
 * @param {object} [opts.server={}] extra options merged into createRoomServer
 * @param {number} [opts.streamInterval] createRoomServer stream interval (ms);
 *   omitted means the server default (matches checks that never passed one)
 * @param {boolean} [opts.context=false] create the page inside a browser
 *   context (for mobile emulation, init scripts, or context-level routing)
 * @param {object} [opts.viewport={width:1440,height:1000}] page/context viewport
 * @param {string|null} [opts.reducedMotion="reduce"] reduced-motion mode for
 *   the page/context; null omits the option
 * @param {object} [opts.pageOptions={}] extra newPage/newContext options
 *   (isMobile, hasTouch, acceptDownloads, ...)
 * @param {Array<Function>} [opts.initScripts=[]] addInitScript functions for
 *   the browser context (requires context: true)
 * @param {number} [opts.defaultTimeout=8000] page.setDefaultTimeout; 0 skips
 * @param {boolean} [opts.makePage=true] set false to skip page creation; the
 *   check creates its own pages from the returned browser
 * @param {boolean} [opts.abortOutside=false] route all requests and abort any
 *   whose origin differs from the local server, collecting URLs in `outside`
 * @param {boolean} [opts.rmFixtureDir=true] remove the fixture directory on teardown
 * @returns {{directory,store,keys,links,server,origin,browser,context,page,errors,outside}}
 */
export async function boot(t, opts = {}) {
  const {
    fixture: fixtureOpts = {},
    server: serverOpts = {},
    streamInterval,
    context: useContext = false,
    viewport = { width: 1440, height: 1000 },
    reducedMotion = "reduce",
    pageOptions = {},
    initScripts = [],
    defaultTimeout = 8000,
    makePage = true,
    abortOutside = false,
    rmFixtureDir = true,
  } = opts;
  const f = createAcceptanceFixture(fixtureOpts);
  const server = createRoomServer({ store: f.store, ...(streamInterval == null ? {} : { streamInterval }), ...serverOpts });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); if (rmFixtureDir) rmSync(f.directory, { recursive: true, force: true });
  });
  const errors = [], outside = [];
  let ctx = null, page = null;
  if (makePage) {
    const surface = { viewport, ...(reducedMotion == null ? {} : { reducedMotion }), ...pageOptions };
    if (useContext) {
      ctx = await browser.newContext(surface);
      for (const fn of initScripts) await ctx.addInitScript(fn);
      if (abortOutside) await ctx.route("**/*", route => {
        if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
        return route.continue();
      });
      page = await ctx.newPage();
    } else {
      page = await browser.newPage(surface);
      if (abortOutside) await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
        return route.continue();
      });
    }
    if (defaultTimeout) page.setDefaultTimeout(defaultTimeout);
    page.on("pageerror", error => errors.push(error.message));
  }
  return { ...f, server, origin, browser, context: ctx, page, errors, outside };
}
