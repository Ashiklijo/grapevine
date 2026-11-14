// Records the demo video's shots from the real site, in demo mode, against live testnet.
//
//   node scripts/serve.mjs --demo            (in another terminal)
//   node demo/record.mjs                     every shot, in story order
//   node demo/record.mjs story,close         only these shots
//
// Each shot is a folder of frames under demo/out/shots, with the moments that matter marked by
// name. Nothing here is staged: every click is a transaction, and the waits are the chain's.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clickOn, moveTo, openBrowser, scrollTo, startShot, typeInto } from "./capture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out");
const SHOTS = path.join(OUT, "shots");
const BASE = process.env.DEMO_URL || "http://127.0.0.1:4180/";
const STORY = pathToFileURL(path.join(HERE, "story.html")).href;
const ZOOM = process.env.DEMO_ZOOM || "1.3";
const TAKE = path.join(OUT, "take.json");
const only = process.argv[2] ? process.argv[2].split(",") : null;

// Who plays whom. A rehearsal can use stand-ins, so the real cast still has no record on the day.
const CAST = { sponsor: "noor", second: "tomas", first: process.env.CAST_FIRST || "bea", middle: process.env.CAST_MIDDLE || "kofi", doer: process.env.CAST_DOER || "rosa" };
const QUEST = {
  title: "Find a sign-language interpreter for Saturday's members' meeting",
  brief: "Asha is deaf, and Saturday is the vote on the new shop. We need a qualified interpreter from 10 to 12 at the hall on Mill Lane.",
  reward: process.env.DEMO_REWARD || "2",
};

const take = fs.existsSync(TAKE) ? JSON.parse(fs.readFileSync(TAKE, "utf8")) : {};
const remember = (patch) => {
  Object.assign(take, patch);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(TAKE, JSON.stringify(take, null, 1));
};
const pause = (page, ms) => page.waitForTimeout(ms);

const { browser, page } = await openBrowser();
await page.addInitScript((zoom) => localStorage.setItem("demo-zoom", zoom), ZOOM);

/** Open a page of the site as one of the demo's people. */
async function as(person, hash) {
  await page.goto(`${BASE}?as=${person}#${hash}`);
  await page.waitForSelector("#app h1, #app .banner");
  await pause(page, 600);
}
const questHash = () => `quest/${take.quest}`;
const node = (account) => page.locator(`.vine .node[data-account^="${account}."]`);
const payRow = (name) => page.locator(".pay", { hasText: name });

const shots = {
  // The story cards that open the video: who needs what, and why nobody on the council can help.
  async story(shot) {
    await page.goto(`${STORY}`);
    await page.evaluate(() => window.show("asha"));
    await pause(page, 400);
    shot.mark("asha");
    await page.evaluate(() => window.step(0));
    await pause(page, 4200);
    shot.mark("badge");
    await page.evaluate(() => window.step(1));
    await pause(page, 3200);
    await page.evaluate(() => window.show("chain"));
    await pause(page, 300);
    shot.mark("chain");
    await page.evaluate(() => window.step(0));
    await pause(page, 2600);
    for (const n of [1, 2, 3]) {
      shot.mark(`hop${n}`);
      await page.evaluate((k) => window.step(k), n);
      await pause(page, 1000);
    }
    await pause(page, 2500);
  },

  // The board, then a steward opens the quest.
  async board(shot) {
    await as(CAST.sponsor, "board");
    shot.mark("hero");
    await pause(page, 5500);
    await moveTo(page, page.locator(".stats"));
    await pause(page, 2500);
    shot.mark("form");
    await clickOn(page, page.locator(".open-form summary"));
    await pause(page, 500);
    await typeInto(page, page.locator('input[name="title"]'), QUEST.title);
    await typeInto(page, page.locator('textarea[name="brief"]'), QUEST.brief, 12);
    await typeInto(page, page.locator('input[name="reward"]'), QUEST.reward, 60);
    shot.mark("typed");
    await pause(page, 500);
    await clickOn(page, page.locator('form[data-form="open"] button.primary'));
    shot.mark("sent");
    await page.waitForFunction(() => location.hash.startsWith("#quest/"), null, { timeout: 90_000 });
    remember({ quest: await page.evaluate(() => location.hash.split("/")[1].split("?")[0]) });
    await page.waitForSelector(".vine");
    shot.mark("opened");
    await page.waitForSelector("#posts .post", { timeout: 60_000 }).catch(() => {});
    await pause(page, 3500);
    await scrollTo(page, page.locator("#posts"), 260);
    shot.mark("post");
    await pause(page, 3500);
  },

  // A member who knows nobody suitable passes it to a friend who might.
  async first(shot) {
    await as(CAST.first, questHash());
    await page.waitForSelector('form[data-form="pass"]');
    shot.mark("panel");
    await pause(page, 2500);
    const suggestion = page.locator(".suggest .pick").first();
    if (await suggestion.count()) {
      await moveTo(page, suggestion);
      shot.mark("suggest");
      await pause(page, 2600);
    }
    await clickOn(page, page.locator('form[data-form="pass"] button.primary'));
    shot.mark("clicked");
    await node(CAST.first).waitFor({ timeout: 90_000 });
    shot.mark("onvine");
    await moveTo(page, node(CAST.first));
    await pause(page, 3000);
  },

  // The friend knows exactly who to ask.
  async middle(shot) {
    await as(CAST.middle, questHash());
    await page.waitForSelector('form[data-form="pass"]');
    shot.mark("panel");
    await moveTo(page, page.locator('select[name="via"]'));
    await pause(page, 1800);
    const suggestion = page.locator(".suggest .pick").first();
    if (await suggestion.count()) {
      await moveTo(page, suggestion);
      shot.mark("suggest");
      await pause(page, 2200);
    }
    await clickOn(page, page.locator('form[data-form="pass"] button.primary'));
    shot.mark("clicked");
    await node(CAST.middle).waitFor({ timeout: 90_000 });
    shot.mark("onvine");
    await moveTo(page, node(CAST.middle));
    await pause(page, 3000);
  },

  // A stranger to the community says yes.
  async doer(shot) {
    await as(CAST.doer, questHash());
    await page.waitForSelector('form[data-form="claim"]');
    shot.mark("panel");
    await pause(page, 1500);
    await typeInto(page, page.locator('form[data-form="claim"] textarea'), "I am free on Saturday morning, and I have interpreted for community meetings before. Kofi sent me this.", 14);
    shot.mark("typed");
    await clickOn(page, page.locator('form[data-form="claim"] button.primary'));
    shot.mark("clicked");
    await page.locator(".vine .tag", { hasText: "I can do this" }).waitFor({ timeout: 90_000 });
    shot.mark("claimed");
    await moveTo(page, node(CAST.doer));
    await pause(page, 3500);
  },

  // The day itself.
  async saturday(shot) {
    await page.goto(`${STORY}`);
    await page.evaluate(() => window.show("saturday"));
    await pause(page, 300);
    shot.mark("title");
    await page.evaluate(() => window.step(0));
    await pause(page, 1800);
    shot.mark("rosa");
    await page.evaluate(() => window.step(1));
    await pause(page, 2000);
    shot.mark("asha");
    await page.evaluate(() => window.step(2));
    await pause(page, 3500);
  },

  // The sponsor accepts, the reward splits, and the trusted share is paid at once.
  async accept(shot) {
    await as(CAST.sponsor, questHash());
    const see = page.locator('button[data-act="preview"]').first();
    await see.waitFor();
    shot.mark("claims");
    await pause(page, 1200);
    await clickOn(page, see);
    await page.waitForSelector(".shares li");
    shot.mark("split");
    for (const row of await page.locator(".shares li").all()) {
      await moveTo(page, row, { settle: 500 });
      await pause(page, 1100);
    }
    shot.mark("read");
    await clickOn(page, page.locator('button[data-act="accept"]'));
    shot.mark("clicked");
    await page.waitForSelector(".pays .pay", { timeout: 90_000 });
    shot.mark("accepted");
    await pause(page, 1500);
    await payRow("Paid from the treasury").first().waitFor({ timeout: 180_000 });
    shot.mark("firstPaid");
    await moveTo(page, payRow("Paid from the treasury").first());
    await pause(page, 3500);
  },

  // A second steward signs off the two newcomers, and the treasury pays them.
  async second(shot) {
    await as(CAST.second, questHash());
    const buttons = page.locator('button[data-act="countersign"]');
    await buttons.first().waitFor({ timeout: 60_000 });
    shot.mark("ready");
    await pause(page, 1500);
    await clickOn(page, buttons.first());
    shot.mark("sign1");
    await page.waitForFunction(() => document.querySelectorAll('button[data-act="countersign"]').length === 1, null, { timeout: 120_000 });
    await pause(page, 800);
    await clickOn(page, page.locator('button[data-act="countersign"]').first());
    shot.mark("sign2");
    await page.waitForFunction(() => document.querySelectorAll(".pay-paid").length >= 3, null, { timeout: 240_000 });
    shot.mark("allPaid");
    await pause(page, 1500);
    await scrollTo(page, page.locator("#vine"), 150);
    await moveTo(page, node(CAST.doer));
    shot.mark("vine");
    await pause(page, 5000);
  },

  // Any payment can be checked against the DAO itself.
  async proposal(shot) {
    await as(CAST.second, questHash());
    const link = page.locator('button[data-act="proposal"]').first();
    await link.waitFor();
    shot.mark("ready");
    await pause(page, 1000);
    await clickOn(page, link);
    await page.waitForSelector(".proposal dl");
    shot.mark("shown");
    await moveTo(page, page.locator(".proposal dl").first());
    await pause(page, 5000);
  },

  async records(shot) {
    await as(CAST.second, "records");
    shot.mark("table");
    await pause(page, 2500);
    const row = page.locator(".table tbody tr", { hasText: "Rosa" }).first();
    await moveTo(page, (await row.count()) ? row : page.locator(".table tbody tr").first());
    await pause(page, 1200);
    await clickOn(page, ((await row.count()) ? row : page.locator(".table tbody tr").first()).locator("a"));
    await page.waitForSelector(".entries li");
    shot.mark("detail");
    await moveTo(page, page.locator(".entries li").first());
    await pause(page, 4000);
  },

  async cheat(shot) {
    await as(CAST.first, "cheat");
    shot.mark("page");
    await pause(page, 1500);
    for (const [i, kind] of ["self_referral", "open_as_outsider"].entries()) {
      await clickOn(page, page.locator(`button[data-kind="${kind}"]`));
      shot.mark(`try${i + 1}`);
      await page.locator(`#verdict-${kind} .chip`).waitFor({ timeout: 90_000 });
      shot.mark(`refused${i + 1}`);
      await pause(page, 1600);
    }
    await pause(page, 2000);
  },

  // The same chain, as posts.
  async social(shot) {
    await as(CAST.first, questHash());
    await page.waitForSelector("#posts .post");
    await scrollTo(page, page.locator("#posts"), 170);
    shot.mark("posts");
    const contractPost = page.locator(".post-contract").first();
    if (await contractPost.count()) {
      await pause(page, 2200);
      await moveTo(page, contractPost);
      shot.mark("contract");
    }
    await pause(page, 5000);
  },

  async close(shot) {
    await page.goto(`${STORY}`);
    await page.evaluate(() => window.show("close"));
    await pause(page, 300);
    shot.mark("mark");
    await page.evaluate(() => window.step(0));
    await pause(page, 1400);
    shot.mark("tag");
    await page.evaluate(() => window.step(1));
    await pause(page, 1800);
    shot.mark("small");
    await page.evaluate(() => window.step(2));
    await pause(page, 5000);
  },
};

const order = ["story", "board", "first", "middle", "doer", "saturday", "accept", "second", "proposal", "records", "cheat", "social", "close"];
for (const name of order) {
  if (only && !only.includes(name)) continue;
  console.log(`recording ${name}...`);
  const started = Date.now();
  // The story cards are a file page with no pointer of its own to hide.
  const shot = await startShot(page, path.join(SHOTS, name));
  try {
    await shots[name](shot);
  } catch (err) {
    console.error(`  ${name} failed: ${err.message.split("\n")[0]}`);
    shot.mark("failed");
  }
  const frames = await shot.stop();
  console.log(`  ${name}: ${frames} frames in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
await browser.close();
