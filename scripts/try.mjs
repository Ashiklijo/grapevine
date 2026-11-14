// Put your own testnet account on a live quest's vine.
//
//   node scripts/try.mjs <you>.testnet [quest id] [--claim "what you did"]
//
// It passes the newest open quest on from your account: one near.social post on testnet's
// FastData, quoting the post you heard it from, and one call that records the link on NEAR.
// Your key must be in the near-cli keychain (~/.near-credentials/testnet/<you>.testnet.json).
//
// Being paid needs a steward of the demo DAO to accept a claim, and those are demo accounts.
// To watch money move end to end on a DAO you control, see docs/DEPLOY.md.
import { deployment, hasKey, log, toNear, txUrl, view } from "./lib.mjs";
import * as act from "./actions.mjs";
import { social, waitForKeys, parseRef } from "./social.mjs";

const args = process.argv.slice(2);
const me = args.find((a) => !a.startsWith("--") && a.includes("."));
const questArg = args.find((a) => /^\d+$/.test(a));
const claimAt = args.indexOf("--claim");
const claimNote = claimAt >= 0 ? args[claimAt + 1] : null;
if (!me) throw new Error('usage: node scripts/try.mjs <you>.testnet [quest id] [--claim "what you did"]');
if (!hasKey(me)) throw new Error(`no key for ${me} in the near-cli keychain. Create the account with near-cli first.`);

const d = deployment();
const board = await view(d.contract, "get_board", { dao: d.dao });
const quests = await view(d.contract, "list_quests", { dao: d.dao, from_index: Math.max(0, board.quests - 40), limit: 40 });
const quest = questArg ? quests.find((q) => q.id === questArg) : [...quests].reverse().find((q) => q.status === "Open");
if (!quest || quest.status !== "Open") throw new Error("no open quest to join. Ask a steward to open one, or run the demo.");

log(`quest ${quest.id}: "${quest.title}", reward ${toNear(quest.reward)} NEAR, sponsored by ${quest.sponsor}`);
const links = await view(d.contract, "list_links", { quest_id: quest.id, from_index: 0, limit: 100 });
const mine = links.find((l) => l.account === me);
if (mine) {
  log(`you are already on the vine, under ${mine.via ?? "the sponsor"}`);
} else {
  // Whoever you follow on the vine is who you most likely heard it from. Otherwise, the last to join.
  const follows = await social.following(me).catch(() => []);
  const known = [...links].reverse().find((l) => follows.includes(l.account));
  const via = (known ?? links.at(-1))?.account ?? null;
  log(`passing it on as ${me}, heard from ${via ?? "the sponsor"}`);
  const res = await act.passOn(d, me, quest.id, via, { withPost: true, note: `Does anyone know someone for this? ${quest.title}` });
  if (!res.ok) throw new Error(`the contract refused: ${res.failures.join("; ")}`);
  log(`link recorded on NEAR: ${txUrl(res.hash)}`);
  log(`your near.social post (the transaction shows as failed by design): ${txUrl(res.postHash)}`);
  const post = parseRef(res.post);
  const landed = await waitForKeys(me, [`post/${post.id}`], 45_000);
  log(landed ? `FastData serves it: https://kv.test.fastnear.com/v0/latest/social/${me}/post/${post.id}` : "FastData has not indexed the post yet; try the link in a minute");
}

if (claimNote) {
  const res = await act.claim(d, me, quest.id, null, claimNote);
  log(res.ok ? `claim recorded: ${txUrl(res.hash)}` : `the contract refused the claim: ${res.failures.join("; ")}`);
}

const chain = await view(d.contract, "list_links", { quest_id: quest.id, from_index: 0, limit: 100 });
const parent = new Map(chain.map((l) => [l.account, l.via]));
const path = [];
for (let a = me; a; a = parent.get(a)) path.push(a);
log(`your path to the sponsor: ${[...path, quest.sponsor].join("  <-  ")}`);
const cfg = board.config;
const cut = (bps) => toNear((BigInt(quest.reward) * BigInt(bps)) / 10000n);
log(`if someone you tell gets it done, your share is ${cut(cfg.relay_bps)} NEAR. If you get it done, ${cut(cfg.doer_bps)} NEAR.`);
log("open the board to see yourself on the vine: npm run site, then http://127.0.0.1:4180/#quest/" + quest.id);
