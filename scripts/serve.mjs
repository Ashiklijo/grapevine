// Serves the site. The site itself is static and reads the chain directly.
//
//   node scripts/serve.mjs            the public, read-only board
//   node scripts/serve.mjs --demo     adds the demo community: you can act as each of its members
//
// Demo mode signs with the demo accounts' testnet keys from the near-cli keychain on this machine.
// It listens on 127.0.0.1 only and will only sign for the accounts named in deployments/testnet.json.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { NETWORK, ROOT, accountUrl, call, deployment, hasKey, keepFloat, keepFloats, loadAccount, log, readableError, txUrl, view } from "./lib.mjs";
import * as act from "./actions.mjs";
import { PEOPLE } from "./people.mjs";

const args = process.argv.slice(2);
const demo = args.includes("--demo");
const port = Number(args[args.indexOf("--port") + 1]) || Number(process.env.PORT) || 4180;
const WEB = path.join(ROOT, "web");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

let d = null;
try {
  d = deployment();
} catch {
  log("no deployment file yet: the site will say so");
}

const personId = (key) => `${key}.${d.hq}`;
const personas = () =>
  Object.entries(PEOPLE)
    .map(([key, info]) => ({ key, account: personId(key), name: info.name, role: info.role, steward: d.people.council.includes(personId(key)) }))
    .filter((p) => hasKey(p.account));

function config() {
  if (!d) return { network: NETWORK, deployed: false, demo: false };
  return {
    network: d.network,
    deployed: true,
    contract: d.contract,
    dao: d.dao,
    hq: d.hq,
    site: d.site || "",
    demo,
    personas: demo ? personas() : [],
  };
}

// One transaction at a time per signer, so nonces never collide.
const queues = new Map();
function inTurn(account, job) {
  const tail = (queues.get(account) || Promise.resolve()).then(job, job);
  queues.set(account, tail.catch(() => {}));
  return tail;
}

const outcome = (res, extra = {}) => ({
  ok: res.ok,
  hash: res.hash,
  url: res.hash ? txUrl(res.hash) : null,
  value: res.value,
  refusal: res.ok ? null : res.failures.map(readableError).join("; "),
  ...extra,
});

/** What each demo button does. Every one is the same contract call a real member would sign. */
const ACTIONS = {
  open_quest: async (who, a) => {
    const before = Number((await view(d.contract, "totals")).quests);
    try {
      const opened = await act.openQuest(d, who, { title: a.title, brief: a.brief, reward: a.reward, days: a.days || 5, withPost: true });
      return { ok: true, hash: opened.hash, url: txUrl(opened.hash), value: opened.id, post: opened.sponsorPost, postUrl: txUrl(opened.postHash) };
    } catch (err) {
      // An RPC error can arrive after the transaction went through. Look on chain before calling it a failure.
      const recent = await view(d.contract, "list_quests", { dao: d.dao, from_index: before, limit: 5 });
      const mine = recent.find((q) => q.sponsor === who && q.title === String(a.title).trim());
      if (!mine) throw err;
      log(`open_quest: the RPC reported "${err.message.split("\n")[0]}", but quest ${mine.id} is open on chain`);
      return { ok: true, hash: null, url: accountUrl(d.contract), value: mine.id, post: mine.sponsor_post };
    }
  },
  pass_on: async (who, a) => {
    const res = await act.passOn(d, who, a.quest_id, a.via || null, { withPost: true, note: a.note, mentions: a.mentions || [] });
    return outcome(res, { post: res.post, postUrl: res.postHash ? txUrl(res.postHash) : null });
  },
  claim: async (who, a) => {
    const res = await act.claim(d, who, a.quest_id, a.via || null, a.note, { withPost: true });
    return outcome(res, { post: res.post });
  },
  accept: async (who, a) => outcome(await act.accept(d, who, a.quest_id, a.doer, a.leave_out || [])),
  countersign: async (who, a) => outcome(await act.countersign(d, who, a.payout_id)),
  decline: async (who, a) => outcome(await act.decline(d, who, a.payout_id, a.reason)),
  close_quest: async (who, a) => outcome(await call(loadAccount(who), d.contract, "close_quest", { quest_id: String(a.quest_id) }, { gas: 30 })),
  advance: async (who, a) => outcome(await act.advance(d, who, a.payout_id)),
  reconcile: async (who, a) => outcome(await act.reconcile(d, who, a.payout_id)),
  // Attempts that the contract should refuse. Used by the "Try to cheat" page.
  cheat: async (who, a) => {
    const quest = String(a.quest_id);
    const me = loadAccount(who);
    const far = String((BigInt(Date.now()) + 86_400_000n) * 1_000_000n);
    const tries = {
      self_referral: () => call(me, d.contract, "pass_on", { quest_id: quest, via: who, post: null }, { gas: 40, deposit: "10000000000000000000000" }),
      change_referrer: () => call(me, d.contract, "pass_on", { quest_id: quest, via: null, post: null }, { gas: 40, deposit: "10000000000000000000000" }),
      open_as_outsider: () =>
        call(me, d.contract, "open_quest", { dao: d.dao, title: "Pay me", brief: "Because I asked.", reward: "500000000000000000000000", deadline: far, sponsor_post: null }, { gas: 80 }),
      accept_as_outsider: () => call(me, d.contract, "accept", { quest_id: quest, doer: who, leave_out: [] }, { gas: 150 }),
      countersign_own: () => call(me, d.contract, "countersign", { payout_id: String(a.payout_id) }, { gas: 300 }),
      push_unsigned: () => call(me, d.contract, "advance", { payout_id: String(a.payout_id) }, { gas: 300 }),
      over_the_cap: () =>
        call(me, d.contract, "open_quest", { dao: d.dao, title: "A very large quest", brief: "More than one steward may open.", reward: "50000000000000000000000000", deadline: far, sponsor_post: null }, { gas: 80 }),
      take_the_float: () => call(me, d.contract, "withdraw_float", { amount: "100000000000000000000000" }, { gas: 30 }),
      forge_callback: () => call(me, d.contract, "on_voted", { payout_id: String(a.payout_id || 1), attempt: 1 }, { gas: 30 }),
      own_board: async () =>
        call(me, d.contract, "create_board", { config: (await view(d.contract, "get_board", { dao: d.dao })).config }, { gas: 100, deposit: "100000000000000000000000" }),
    };
    if (!tries[a.kind]) throw new Error("unknown attempt");
    return outcome(await tries[a.kind]());
  },
};

async function handleAct(body) {
  const { as, action, args: a = {} } = body;
  const who = personas().find((p) => p.key === as || p.account === as);
  if (!who) throw new Error("not a demo account");
  if (!ACTIONS[action]) throw new Error("unknown action");
  const started = Date.now();
  const took = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  try {
    const out = await inTurn(who.account, () => ACTIONS[action](who.account, a));
    log(`${action} as ${who.key}: ${out.ok ? "ok" : `refused, ${out.refusal}`} in ${took()}`);
    return out;
  } catch (err) {
    log(`${action} as ${who.key}: failed in ${took()}: ${err.message.split("\n")[0]}`);
    throw err;
  }
}

// The keeper: anyone may push a decided payment forward. In the demo this server does it.
// Every quarter of an hour it also has the contract re-read who the DAO's council is.
let keeping = false;
let syncedAt = Date.now();
async function keep() {
  if (keeping || !d) return;
  keeping = true;
  try {
    const board = await view(d.contract, "get_board", { dao: d.dao });
    if (!board) return;
    if (Date.now() - syncedAt > 15 * 60_000) {
      syncedAt = Date.now();
      await inTurn(d.people.keeper, () => call(loadAccount(d.people.keeper), d.contract, "sync", { dao: d.dao }, { gas: 100 }));
    }
    if (board.paused_by) return;
    const from = Math.max(0, board.quests - 12);
    const quests = await view(d.contract, "list_quests", { dao: d.dao, from_index: from, limit: 12 });
    for (const quest of quests.filter((q) => q.status === "Settling")) {
      await inTurn(d.people.keeper, () => act.settle(d, d.people.keeper, quest.id, { timeoutMs: 1 }));
    }
  } catch (err) {
    log(`keeper: ${err.message}`);
  } finally {
    keeping = false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 64_000) reject(new Error("too large"));
      else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        reject(new Error("not JSON"));
      }
    });
    req.on("error", reject);
  });
}

const send = (res, status, type, body) => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};
const json = (res, status, value) => send(res, status, TYPES[".json"], JSON.stringify(value));

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/config.json") return json(res, 200, config());
    if (url.pathname === "/evidence.json") {
      const file = path.join(ROOT, "deployments", "testnet-e2e.json");
      return fs.existsSync(file) ? send(res, 200, TYPES[".json"], fs.readFileSync(file)) : json(res, 404, { error: "not run yet" });
    }
    if (url.pathname === "/api/act") {
      if (!demo) return json(res, 404, { error: "demo mode is off" });
      if (req.method !== "POST") return json(res, 405, { error: "POST only" });
      // Only pages served from this server may call it.
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: "cross-site" });
      try {
        return json(res, 200, await handleAct(await readBody(req)));
      } catch (err) {
        return json(res, 400, { ok: false, refusal: err.message });
      }
    }
    const name = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(WEB, name));
    if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return send(res, 404, "text/plain", "not found");
    }
    return send(res, 200, TYPES[path.extname(file)] || "application/octet-stream", fs.readFileSync(file));
  } catch (err) {
    return send(res, 500, "text/plain", err.message);
  }
});

server.listen(port, "127.0.0.1", () => {
  log(`Grapevine ${demo ? "demo" : "site"} on http://127.0.0.1:${port}`);
  if (demo) {
    log("demo mode: signing with this machine's testnet keys for the demo accounts only");
    (async () => {
      await keepFloats(d);
      // The "Try to cheat" page signs steward calls as these two, and a call reserves its gas up front.
      for (const id of d.people.others.filter((a) => /^(mallory|sock)\./.test(a))) await keepFloat(loadAccount(d.hq), id, "0.5");
    })().catch((err) => log(`could not top up the demo accounts: ${err.message}`));
    // Every 8 seconds: often enough to settle a payment within a minute, and light on free RPC tiers.
    setInterval(keep, 8000);
  }
});
