// A scout: for one account, find the open quests that someone in its near.social circle could do.
//
//   node scripts/scout.mjs <account>            list matches. Reads only, needs no key.
//   node scripts/scout.mjs <account> --pass     also pass each matching quest on, mentioning the match
//
// This is the whole "agent" for Grapevine: read the board, read who you follow, and tell the one
// person who fits. It never passes a quest on without a match, because a pass that reaches nobody
// who can do the work earns nothing.
import { deployment, hasKey, log, toNear, txUrl, view } from "./lib.mjs";
import * as act from "./actions.mjs";
import { social } from "./social.mjs";

const args = process.argv.slice(2);
const me = args.find((a) => !a.startsWith("--"));
const pass = args.includes("--pass");
if (!me) throw new Error("usage: node scripts/scout.mjs <account> [--pass]");
if (pass && !hasKey(me)) throw new Error(`--pass needs ${me}'s key in the near-cli keychain`);

const d = deployment();
const board = await view(d.contract, "get_board", { dao: d.dao });
const quests = (await view(d.contract, "list_quests", { dao: d.dao, from_index: Math.max(0, board.quests - 60), limit: 60 })).filter(
  (q) => q.status === "Open" && Date.now() < Number(BigInt(q.deadline) / 1_000_000n),
);
log(`${quests.length} open quest(s) on ${d.dao}`);

for (const quest of quests) {
  const links = await view(d.contract, "list_links", { quest_id: quest.id, from_index: 0, limit: 100 });
  const onVine = new Set([quest.sponsor, ...links.map((l) => l.account)]);
  const matches = (await social.suggest(me, `${quest.title} ${quest.brief}`)).filter((m) => !onVine.has(m.account));
  console.log(`\n#${quest.id}  ${quest.title}  (${toNear(quest.reward)} NEAR)`);
  if (!matches.length) {
    console.log("    nobody in your circle looks like a fit. Not passing it on.");
    continue;
  }
  for (const m of matches) console.log(`    ${m.name ?? m.account} (${m.account}): matches "${m.hits.join(", ")}"  ${m.because ? `"${m.because.slice(0, 80)}"` : ""}`);
  if (!pass) continue;
  if (onVine.has(me)) {
    console.log("    you already passed this one on.");
    continue;
  }
  const follows = await social.following(me).catch(() => []);
  const via = [...links].reverse().find((l) => follows.includes(l.account))?.account ?? null;
  const best = matches[0];
  const res = await act.passOn(d, me, quest.id, via, {
    withPost: true,
    note: `${best.name ?? best.account}, this sounds like you: ${quest.title}`,
    mentions: [best.account],
  });
  console.log(res.ok ? `    passed on, heard from ${via ?? "the sponsor"}: ${txUrl(res.hash)}` : `    refused: ${res.failures.join("; ")}`);
}
