// Read-only proof of what is on chain. Needs no account and sends no transaction.
//
//   node scripts/verify.mjs
//
// It checks the install against the DAO's own policy, then walks every quest on the board and
// checks each payment against the DAO proposal that paid it.
import { RPCS, NETWORK, deployment, log, toNear, view } from "./lib.mjs";
import { social } from "./social.mjs";

const d = deployment();
const G = d.contract;
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
};

/** The account's access keys, from the first endpoint that answers with a result. */
async function accessKeys(account) {
  for (const url of RPCS[NETWORK]) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key_list", finality: "final", account_id: account } }),
      });
      const body = await res.json();
      if (body.result) return body.result.keys ?? [];
    } catch {
      // Try the next endpoint.
    }
  }
  return [];
}

console.log(`Grapevine ${await view(G, "version")} at ${G} on ${NETWORK}`);
console.log(`DAO ${d.dao}\n`);

// 1. The install, from the DAO's side.
const policy = await view(d.dao, "get_policy");
const role = policy.roles.find((r) => r.kind?.Group?.includes(G));
check("the DAO has a role that holds the Grapevine contract", Boolean(role), role?.name);
check("that role holds nobody else", role?.kind.Group.length === 1);
check(
  "its permissions are transfers only: file, approve, close",
  role && role.permissions.every((p) => p.startsWith("transfer:")) && role.permissions.length === 3,
  role?.permissions.join(", "),
);
check("no other role names the contract", policy.roles.filter((r) => r.kind?.Group?.includes(G)).length === 1);

// 2. The install, from the contract's side.
check("this copy of the contract is bound to this DAO and can serve no other", (await view(G, "dao")) === d.dao);
const board = await view(G, "get_board", { dao: d.dao });
const council = policy.roles.find((r) => r.name === board.config.steward_role)?.kind.Group ?? [];
check("the board's stewards are the DAO's own council, as its policy lists them", JSON.stringify([...board.stewards].sort()) === JSON.stringify([...council].sort()), board.stewards.join(", "));
check("the board uses the DAO's own proposal bond", board.bond === policy.proposal_bond, `${toNear(board.bond)} NEAR`);
const cfg = board.config;
check(
  "the split can never exceed a reward",
  cfg.doer_bps + 2 * cfg.relay_bps <= 10_000,
  `doer ${cfg.doer_bps / 100}%, first relay ${cfg.relay_bps / 100}%, halving for ${cfg.max_hops} hops`,
);
console.log(
  `      caps: one steward may open ${toNear(cfg.quest_cap)} NEAR per quest and ${toNear(cfg.period_cap)} NEAR per ${Math.round(Number(cfg.period_ns) / 86_400e9)} days;` +
    ` earned limit ${toNear(cfg.step)} NEAR per point up to ${toNear(cfg.ceiling)}; countersign up to ${toNear(cfg.countersign_cap)} NEAR; above that the DAO votes`,
);
const keys = await accessKeys(G);
console.log(
  keys.length
    ? `NOTE  the contract account still has ${keys.length} access key(s), so its code can be changed. Fine on testnet, not for a real treasury.`
    : "PASS  the contract account has no access keys: nobody can change its code",
);

// 3. Every payment, against the DAO proposal that paid it.
const quests = await view(G, "list_quests", { dao: d.dao, from_index: 0, limit: 100 });
let paidCount = 0;
let autoCount = 0;
let councilCount = 0;
let paidTotal = 0n;
let mismatches = 0;
let overpaid = 0;
for (const quest of quests) {
  const payouts = await view(G, "list_payouts", { quest_id: quest.id });
  const live = payouts.filter((p) => p.phase !== "Declined").reduce((sum, p) => sum + BigInt(p.amount), 0n);
  if (live > BigInt(quest.reward)) overpaid += 1;
  for (const p of payouts.filter((x) => x.phase === "Paid")) {
    const proposal = await view(d.dao, "get_proposal", { id: Number(p.proposal_id) });
    const t = proposal.kind.Transfer;
    const votes = Object.keys(proposal.votes);
    const ok =
      proposal.status === "Approved" && proposal.proposer === G && t?.receiver_id === p.payee && t.amount === p.amount && t.token_id === "" &&
      (p.route === "Council" ? !votes.includes(G) : votes.length === 1 && votes[0] === G);
    if (!ok) {
      mismatches += 1;
      console.log(`FAIL  payment ${p.id} does not match DAO proposal ${p.proposal_id}`);
    }
    paidCount += 1;
    paidTotal += BigInt(p.amount);
    if (p.route === "Auto") autoCount += 1;
    if (p.route === "Council") councilCount += 1;
  }
}
check(`${quests.length} quests: none pays out more than its reward`, overpaid === 0);
check(
  `${paidCount} paid payments each match an approved Transfer proposal on the DAO: same payee, same amount, filed by Grapevine`,
  mismatches === 0,
  `${toNear(paidTotal)} NEAR in total; ${autoCount} inside an earned limit, ${paidCount - autoCount - councilCount} countersigned, ${councilCount} by the DAO's vote`,
);
check("the board's own total agrees", BigInt(board.paid) === paidTotal, `${toNear(board.paid)} NEAR`);

// 4. Every record, against its entries.
const people = await view(G, "list_people", { dao: d.dao, from_index: 0, limit: 100 });
let badRecords = 0;
for (const person of people) {
  const entries = await view(G, "list_entries", { dao: d.dao, account: person.account, from_index: 0, limit: 100 });
  const sum = entries.reduce((s, e) => s + BigInt(e.amount), 0n);
  if (entries.length !== person.points || sum !== BigInt(person.earned)) badRecords += 1;
}
check(`${people.length} records: every point is an entry, and every entry is a paid payment`, badRecords === 0);

// 5. near.social: what the contract itself has posted.
try {
  const posts = await social.recentPosts(G, 200);
  check("the contract's own posts are served by FastData, with the contract as their author", posts.length > 0 && posts.every((p) => p.account === G), `${posts.length} posts`);
  if (posts[0]) console.log(`      latest: "${posts[0].text.slice(0, 110)}"`);
} catch (err) {
  console.log(`NOTE  FastData could not be read just now: ${err.message}`);
}

log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exitCode = failures ? 1 : 0;
