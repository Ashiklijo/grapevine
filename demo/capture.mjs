// Screen capture for the demo video: a real browser driving the real site against live testnet.
// Frames come from Chrome's screencast at 1920x1080, each with its true timestamp, so the edit
// can squeeze the seconds spent waiting for a block and keep the rest in real time.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

export const SIZE = { width: 1920, height: 1080 };

export async function openBrowser() {
  const browser = await chromium.launch({ headless: true, args: ["--force-color-profile=srgb", "--hide-scrollbars"] });
  const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, colorScheme: "light" });
  // The pointer and the page zoom are set before any page script runs, on every navigation.
  await context.addInitScript(POINTER);
  const page = await context.newPage();
  return { browser, context, page };
}

// Headless Chrome draws no pointer, so the page draws one. It also draws a ripple on each click.
const POINTER = `
(() => {
  const ready = () => {
    if (window.__pointer || !document.documentElement) return;
    // Read here, not above: on the first page the zoom is stored by a script that runs after this one.
    const ZOOM = Number(localStorage.getItem('demo-zoom') || 1);
    if (ZOOM !== 1) document.documentElement.style.zoom = String(ZOOM);
    const p = document.createElement('div');
    p.id = 'demo-pointer';
    p.style.cssText = 'position:fixed;left:0;top:0;width:34px;height:34px;z-index:2147483647;pointer-events:none;transform:translate(1500px,820px);transition:transform .6s cubic-bezier(.3,.8,.3,1);';
    p.innerHTML = '<svg viewBox="0 0 24 24" width="34" height="34"><path d="M4 2l15 11-6.6.9L16 21l-3 1.3-3.5-7.2L5 19z" fill="#1d1b16" stroke="#fff" stroke-width="1.4"/></svg>';
    document.documentElement.appendChild(p);
    const z = () => parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    window.__pointer = (x, y) => { p.style.transform = 'translate(' + x / z() + 'px,' + y / z() + 'px)'; };
    window.__ripple = (x, y) => {
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;width:16px;height:16px;border-radius:50%;left:' + (x / z() - 8) + 'px;top:' + (y / z() - 8) + 'px;border:3px solid #5b3d8a;transition:transform .45s ease-out,opacity .45s ease-out;';
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = 'scale(4.5)'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 520);
    };
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();`;

/** Glide the pointer to the middle of an element, scrolling it into view first. */
export async function moveTo(page, locator, { settle = 650 } = {}) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const x = box.x + Math.min(box.width / 2, 160);
  const y = box.y + box.height / 2;
  await page.evaluate(([px, py]) => window.__pointer?.(px, py), [x, y]);
  await page.waitForTimeout(settle);
  return { x, y };
}

export async function clickOn(page, locator) {
  const { x, y } = await moveTo(page, locator);
  await page.evaluate(([px, py]) => window.__ripple?.(px, py), [x, y]);
  await page.waitForTimeout(140);
  await locator.click();
}

export async function typeInto(page, locator, text, delay = 26) {
  await clickOn(page, locator);
  await locator.fill("");
  await locator.pressSequentially(text, { delay });
}

/** Scroll the window smoothly so an element sits `offset` pixels below the top. */
export async function scrollTo(page, locator, offset = 140) {
  await locator.evaluate((el, off) => {
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const top = el.getBoundingClientRect().top * 1 + window.scrollY - off / zoom;
    window.scrollTo({ top, behavior: "smooth" });
  }, offset);
  await page.waitForTimeout(900);
}

/**
 * Record a shot. `mark(name)` notes the moment something happened, for the edit to cut on.
 * Returns stop(), which writes frames.json and events.json next to the frames.
 */
export async function startShot(page, dir, quality = 93) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const events = {};
  let n = 0;
  let last = 0;
  cdp.on("Page.screencastFrame", async (event) => {
    const name = `f${String(n).padStart(6, "0")}.jpg`;
    n += 1;
    last = event.metadata.timestamp;
    fs.writeFileSync(path.join(dir, name), Buffer.from(event.data, "base64"));
    frames.push({ name, t: event.metadata.timestamp });
    try {
      await cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId });
    } catch {
      // The session ended between the frame and its acknowledgement.
    }
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality, maxWidth: SIZE.width, maxHeight: SIZE.height, everyNthFrame: 1 });
  // A frame's timestamp is Unix time in seconds, the same clock as Date.now().
  await page.waitForTimeout(250);
  const mark = (name) => {
    events[name] = Date.now() / 1000;
    return events[name];
  };
  mark("start");
  const stop = async () => {
    mark("end");
    await page.waitForTimeout(200);
    await cdp.send("Page.stopScreencast");
    fs.writeFileSync(path.join(dir, "frames.json"), JSON.stringify({ frames, end: Math.max(last, events.end) }));
    fs.writeFileSync(path.join(dir, "events.json"), JSON.stringify(events, null, 1));
    return frames.length;
  };
  return { mark, stop };
}
