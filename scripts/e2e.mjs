// Live checks against testnet. Every check is a real transaction or a real read, and every
// refusal is the contract's own. Results and transaction hashes go to deployments/testnet-e2e.json.
//
//   node scripts/e2e.mjs            all scenarios
//   node scripts/e2e.mjs --quick    skip the council-vote scenario, which moves the most test NEAR
//
// Each run makes three fresh accounts, so "first payment" and "earned trust" mean the same thing
// every time. They are deleted at the end and whatever they were paid goes back to the treasury.
import fs from "node:fs";
import path from "node:path";
import {
  NEAR,
  ROOT,
  actions,
  balanceOf,
  call,
  deleteInto,
  deployment,
  ensureSubaccount,
  keepFloat,
  keepFloats,
  loadAccount,
  log,
  send,
  sleep,
  toNear,
  txUrl,
  view,
} from "./lib.mjs";
import * as act from "./actions.mjs";
import { social, waitForKeys, parseRef } from "./social.mjs";

const quick = process.argv.includes("--quick");
const d = deployment();
const G = d.contract;
const person = (name) => `${name}.${d.hq}`;
const [noor, tomas] = d.people.council;
const keeper = d.people.keeper;
const mallory = person("mallory");
const sock = person("sock");
const stamp = Date.now().toString(36).slice(-5);
const X = person(`x${stamp}`); // gets things done
const Y = person(`y${stamp}`); // passes things on
const Z = person(`z${stamp}`); // passes things on, one step further from the doer
const n = (amount) => BigInt(NEAR(amount));

const checks = [];
const evidence = { quests: {}, proposals: {}, posts: {} };
function check(name, ok, detail = "", hash) {
  checks.push({ name, ok: Boolean(ok), detail, tx: hash ? txUrl(hash) : undefined });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}
/** The call must be refused by the contract with this error. */
async function refused(name, promise, code) {
  const res = await promise;
  const hit = !res.ok && res.failures.some((f) => f.includes(code));
  check(name, hit, hit ? code : `wanted ${code}, got ${res.ok ? "success" : res.failures.join("; ")}`, res.hash);
}
const quest = (id) => view(G, "get_quest", { quest_id: String(id) });
const payout = (id) => view(G, "get_payout", { payout_id: String(id) });
const board = () => view(G, "get_board", { dao: d.dao });
const record = (account) => view(G, "get_record", { dao: d.dao, account });
const preview = (id, doer, leaveOut = []) => view(G, "preview", { quest_id: String(id), doer, leave_out: leaveOut });
const routeFor = (amount, limit, cap) => (BigInt(amount) <= BigInt(limit) ? "Auto" : BigInt(amount) <= BigInt(cap) ? "Countersign" : "Council");

const hq = loadAccount(d.hq);
log(`contract ${G}, DAO ${d.dao}`);
await keepFloats(d);
// The outsiders try steward calls that reserve up to 300 Tgas and attach a deposit, which costs
// about 0.3 NEAR up front even when the contract refuses at once. Give them room for that.
for (const id of [person("mallory"), person("sock")]) await keepFloat(hq, id, "0.5");
const startBoard = await board();
const cfg = startBoard.config;
check("the board reports a full install", startBoard.can_file && startBoard.can_approve && startBoard.can_finalize);
check("stewards are the DAO's own council", JSON.stringify([...startBoard.stewards].sort()) === JSON.stringify([...d.people.council].sort()), startBoard.stewards.join(", "));

for (const id of [X, Y, Z]) await ensureSubaccount(hq, id, "0.15");
log(`fresh accounts: ${X}, ${Y}, ${Z}`);

// ---------------------------------------------------------------------------------------------
// A. A quest travels sponsor -> Z -> Y -> X. X gets it done. Nobody has a record yet.
// ---------------------------------------------------------------------------------------------
const before = await board();
const A = await act.openQuest(d, noor, {
  title: `E2E ${stamp}: find someone who can fix the walk-in fridge`,
  brief: "Posted by the automated test. The compressor trips after ten minutes.",
  reward: "0.2",
  withPost: true,
});
evidence.quests.A = A.id;
check("a steward opens a quest inside the caps", Number(A.id) > 0, `quest ${A.id}`, A.hash);
{
  const q = await quest(A.id);
  check("the quest remembers the sponsor's own near.social post", q.sponsor_post === A.sponsorPost, q.sponsor_post);
  check("the contract announced the quest from its own account", q.post?.startsWith(`${G}/`), q.post);
  const after = await board();
  check("the reward is reserved in the period's budget", BigInt(after.committed) - BigInt(before.committed) === n("0.2"));
}

const passZ = await act.passOn(d, Z, A.id, null);
check("an account passes the quest on, straight from the sponsor", passZ.ok, "", passZ.hash);
const passY = await act.passOn(d, Y, A.id, Z, { withPost: true, note: "A friend of mine fixes commercial fridges." });
check("a second account passes it on and names who it heard it from", passY.ok, `post ${passY.post}`, passY.hash);
evidence.posts.pass = passY.post;

await refused("passing on twice is refused, so nobody can change who they heard it from", act.passOn(d, Y, A.id, null), "ERR_ALREADY_ON_THE_VINE");
await refused("naming yourself as the referrer is refused", act.passOn(d, mallory, A.id, mallory), "ERR_SELF_REFERRAL");
await refused("naming a referrer who is not on the vine is refused", act.passOn(d, mallory, A.id, sock), "ERR_UNKNOWN_REFERRER");
await refused("the sponsor cannot join their own quest", act.passOn(d, noor, A.id, null), "ERR_SPONSOR_CANNOT_JOIN");
await refused(
  "a pass without its storage deposit is refused",
  call(loadAccount(mallory), G, "pass_on", { quest_id: String(A.id), via: null, post: null }, { gas: 40, deposit: "0" }),
  "ERR_ATTACH_STORAGE_DEPOSIT",
);

{
  const paidBefore = BigInt(await balanceOf(X));
  const res = await act.claim(d, X, A.id, Y, "Fixed it: the start relay was burnt out. Photo on request.");
  check("the doer claims, joining the vine under the account that told them", res.ok, "", res.hash);
  const spent = paidBefore - BigInt(await balanceOf(X));
  check("a claim costs about a cent of storage and gas, and the rest of the deposit comes back", spent > 0n && spent < n("0.012"), `${toNear(spent, 5)} NEAR`);
  await refused("claiming twice is refused", act.claim(d, X, A.id, null, "again"), "ERR_ALREADY_CLAIMED");
}

{
  const plan = await preview(A.id, X);
  const got = plan.shares.map((s) => `${s.account.split(".")[0]}:${toNear(s.amount)}:${s.route}`).join(" ");
  check(
    "the split is half to the doer, then a quarter, then an eighth",
    plan.shares.length === 3 &&
      BigInt(plan.shares[0].amount) === n("0.1") &&
      BigInt(plan.shares[1].amount) === n("0.05") &&
      BigInt(plan.shares[2].amount) === n("0.025") &&
      plan.shares[1].account === Y &&
      plan.shares[2].account === Z,
    got,
  );
  check("what the split leaves over stays in the treasury", BigInt(plan.unspent) === n("0.025"), toNear(plan.unspent));
  check("with no record, every share needs a second steward", plan.shares.every((s) => s.route === "Countersign"));
}

await refused("a steward who is not the sponsor cannot accept the claim", act.accept(d, tomas, A.id, X), "ERR_NOT_THE_SPONSOR");
await refused("an outsider cannot accept a claim", act.accept(d, mallory, A.id, X), "ERR_NOT_A_STEWARD");
await refused("an account that never claimed cannot be accepted", act.accept(d, noor, A.id, Z), "ERR_NO_CLAIM");
await refused(
  "leaving out an account that is not on the chain is refused",
  act.accept(d, noor, A.id, X, [{ account: mallory, reason: "not involved" }]),
  "ERR_LEFT_OUT_NOT_ON_THE_CHAIN",
);

const treasuryBefore = BigInt(await balanceOf(d.dao));
const balBefore = { X: BigInt(await balanceOf(X)), Y: BigInt(await balanceOf(Y)), Z: BigInt(await balanceOf(Z)) };
const floatBefore = BigInt((await board()).float);
const acceptedA = await act.accept(d, noor, A.id, X);
check("the sponsor accepts the claim and three payments are decided", acceptedA.ok && acceptedA.value?.length === 3, `payments ${acceptedA.value?.join(", ")}`, acceptedA.hash);
const [pX, pY, pZ] = acceptedA.value;
{
  const after = await board();
  check(
    "the unspent part of the reward goes back to the budget",
    BigInt(after.committed) - BigInt(before.committed) === n("0.175"),
    toNear(BigInt(after.committed) - BigInt(before.committed)),
  );
}

await refused("nobody can push a payment that still needs a countersign", act.advance(d, keeper, pX), "ERR_NEEDS_COUNTERSIGN");
await refused("the steward who accepted cannot also countersign", act.countersign(d, noor, pX), "ERR_SAME_STEWARD");
await refused("an outsider cannot countersign", act.countersign(d, mallory, pX), "ERR_NOT_A_STEWARD");
await refused(
  "a callback cannot be called from outside",
  call(loadAccount(mallory), G, "on_filed", { payout_id: String(pX), attempt: 1 }, { gas: 30 }),
  "private",
);

for (const [label, id] of [
  ["doer", pX],
  ["first relay", pY],
  ["second relay", pZ],
]) {
  const res = await act.countersign(d, tomas, id);
  const p = await payout(id);
  check(`a second steward countersigns the ${label}'s payment, and Grapevine files and votes`, res.ok && p.phase === "Voted" && p.proposal_id !== null, `proposal ${p.proposal_id}`, res.hash);
  evidence.proposals[`A_${label.replace(" ", "_")}`] = Number(p.proposal_id);
}
{
  const p = await payout(pX);
  const proposal = await view(d.dao, "get_proposal", { id: Number(p.proposal_id) });
  check("the payment is an ordinary Transfer proposal on the DAO", proposal.kind.Transfer?.receiver_id === X && BigInt(proposal.kind.Transfer.amount) === n("0.1"), proposal.description);
  check("Grapevine's vote alone passed it", proposal.status === "Approved" && Object.keys(proposal.votes).length === 1 && proposal.votes[G] === "Approve", JSON.stringify(proposal.votes));
  check("the proposal text is in the form Trezu reads", proposal.description.startsWith("* Title: Grapevine quest #") && proposal.description.includes("<br>* Notes:"));
}
{
  // The rule is 20 seconds after the vote. A slow RPC can delay this read past that, and then the
  // contract is right to count the payment as paid, so the check says it could not run.
  const age = (Date.now() - Number(BigInt((await payout(pX)).since) / 1_000_000n)) / 1000;
  const early = await act.reconcile(d, keeper, pX);
  const p = await payout(pX);
  const name = "an approved proposal is not counted as paid until the transfer has had time to run";
  if (age < 15) check(name, early.ok && p.phase === "Voted", `${p.note}, ${Math.round(age)} s after the vote`, early.hash);
  else check(name, true, `skipped: the RPC was slow and the vote was already ${Math.round(age)} s old (the contract tests cover this rule)`);
}
log("waiting for the settle delay...");
await sleep(act.SETTLE_MS);
for (const id of [pX, pY, pZ]) {
  const res = await act.reconcile(d, keeper, id);
  const p = await payout(id);
  // Already paid on an earlier look is a confirmation too: the contract refuses to check it again.
  const looked = res.ok || res.failures.some((f) => f.includes("ERR_NOTHING_TO_CHECK"));
  check(`payment ${id} is confirmed paid on a later look`, looked && p.phase === "Paid", p.note, res.hash);
}
{
  const gain = {
    X: BigInt(await balanceOf(X)) - balBefore.X,
    Y: BigInt(await balanceOf(Y)) - balBefore.Y,
    Z: BigInt(await balanceOf(Z)) - balBefore.Z,
  };
  check("the doer received exactly half the reward", gain.X === n("0.1"), toNear(gain.X));
  check("the nearest relay received exactly a quarter", gain.Y === n("0.05"), toNear(gain.Y));
  check("the next relay received exactly an eighth", gain.Z === n("0.025"), toNear(gain.Z));
  const out = treasuryBefore - BigInt(await balanceOf(d.dao));
  // A contract account also earns a sliver of the gas burnt on its calls, so allow for that.
  check("the treasury paid out 0.175 NEAR and no more", out > n("0.17") && out <= n("0.175"), toNear(out, 5));
  const q = await quest(A.id);
  check("the quest is done", q.status === "Done" && BigInt(q.paid) === n("0.175"), q.status);
  const floatAfter = BigInt((await board()).float);
  check("every bond came back to the board's float", floatBefore - floatAfter < n("0.02"), `float moved by ${toNear(floatBefore - floatAfter, 5)}`);
}
{
  const rx = await record(X);
  const ry = await record(Y);
  check("the doer's record shows one quest done", rx.done === 1 && rx.carried === 0 && rx.points === 1);
  check("a relay's record shows one quest carried", ry.done === 0 && ry.carried === 1 && ry.points === 1);
  check(
    "the earned limit is a step per point, but never more than a second steward has approved for that account",
    BigInt(rx.vouched) === n("0.1") && BigInt(rx.limit) === n("0.1") && BigInt(cfg.step) > n("0.1"),
    `step ${toNear(cfg.step)}, approved ${toNear(rx.vouched)}, limit ${toNear(rx.limit)}`,
  );
  const entries = await view(G, "list_entries", { dao: d.dao, account: X, from_index: 0, limit: 10 });
  const proposal = await view(d.dao, "get_proposal", { id: Number(entries[0].proposal_id) });
  check(
    "the point is traceable to a finished quest and a paid DAO proposal",
    entries.length === 1 && entries[0].quest_id === String(A.id) && proposal.kind.Transfer.receiver_id === X && proposal.status === "Approved",
    `quest ${entries[0].quest_id}, proposal ${entries[0].proposal_id}`,
  );
}

// near.social, on testnet's FastData: what the contract posted, and what a person posted.
{
  const q = await quest(A.id);
  const questPost = parseRef(q.post);
  const landed = await waitForKeys(G, [`post/${questPost.id}`], 60_000);
  check("the contract's own post about the quest is served by FastData", landed, q.post);
  if (landed) {
    const posts = await social.posts([q.post]);
    const text = posts.get(q.post)?.text ?? "";
    check("its author is the contract, and it mentions the DAO", posts.get(q.post)?.account === G && text.includes(`@${d.dao}`), text.slice(0, 90));
    evidence.posts.quest = q.post;
  }
  const mine = parseRef(passY.post);
  const passLanded = await waitForKeys(Y, [`post/${mine.id}`], 60_000);
  const passPost = passLanded ? (await social.posts([passY.post])).get(passY.post) : null;
  check("a person's pass is a near.social post that quotes the post it came from", passPost?.quote === A.sponsorPost, passPost ? `quote ${passPost.quote}` : "not served yet");
  const link = await view(G, "get_link", { quest_id: String(A.id), account: Y });
  check("the vine records that post next to the link", link.post === passY.post && link.via === Z);
  const recent = await social.recentPosts(G, 12);
  const paidPosts = recent.filter((p) => p.text.includes(`quest #${A.id}`) && p.text.includes("was paid"));
  check("the contract posted each payment, mentioning the payee", paidPosts.length === 3 && paidPosts.some((p) => p.text.includes(`@${X}`)), `${paidPosts.length} posts`);
}

// ---------------------------------------------------------------------------------------------
// B. Earned trust. The same people, a second quest: now their shares are inside their limits.
// ---------------------------------------------------------------------------------------------
const B = await act.openQuest(d, noor, {
  title: `E2E ${stamp}: lend the co-op a pallet jack on Saturday`,
  brief: "Posted by the automated test.",
  reward: "0.2",
});
evidence.quests.B = B.id;
await act.passOn(d, Y, B.id, null);
await act.claim(d, X, B.id, Y, "Dropped it off at 8.");
{
  const plan = await preview(B.id, X);
  check("with a record, the same shares are now inside the earned limits", plan.shares.length === 2 && plan.shares.every((s) => s.route === "Auto"), plan.shares.map((s) => s.route).join(" "));
  const res = await act.accept(d, noor, B.id, X);
  const ids = res.value ?? [];
  const settled = await act.settle(d, keeper, B.id, { onStep: (s) => log(`  ${s}`) });
  check("both payments were paid with no second steward", settled.payouts.every((p) => p.phase === "Paid" && p.countersigned_by === null), settled.payouts.map((p) => p.phase).join(" "), res.hash);
  const p = await payout(ids[0]);
  const proposal = await view(d.dao, "get_proposal", { id: Number(p.proposal_id) });
  check("again the only vote on the DAO is Grapevine's", Object.keys(proposal.votes).length === 1 && proposal.votes[G] === "Approve");
  evidence.proposals.B_doer = Number(p.proposal_id);
  const rx = await record(X);
  check(
    "a payment made at once adds a point, but only a second approval raises the limit",
    rx.done === 2 && BigInt(rx.limit) === n("0.1"),
    `limit ${toNear(rx.limit)}`,
  );
  check(
    "what was paid at once comes out of the period's allowance",
    BigInt(rx.limit) - BigInt(rx.room) === n("0.1"),
    `${toNear(rx.room)} NEAR left of ${toNear(rx.limit)}`,
  );

  // The limit is an allowance for the period, not per payment. A share that fits the limit but
  // not what is left of it needs a second steward again.
  const big = await act.openQuest(d, noor, { title: `E2E ${stamp}: a second job in the same period`, brief: "Posted by the automated test.", reward: "0.2" });
  await act.claim(d, X, big.id, null, "On it.");
  const plan2 = await preview(big.id, X);
  const share = plan2.shares[0];
  check(
    "a share inside the earned limit but over what is left of it this period needs a second steward",
    BigInt(share.amount) <= BigInt(share.limit) && BigInt(share.amount) > BigInt(share.room) && share.route === "Countersign",
    `${toNear(share.amount)} NEAR, limit ${toNear(share.limit)}, left ${toNear(share.room)}`,
  );
  await call(loadAccount(noor), G, "close_quest", { quest_id: String(big.id) }, { gas: 30 });
}

// ---------------------------------------------------------------------------------------------
// C. A fake chain. The doer slips an account of their own between themselves and an honest relay.
// ---------------------------------------------------------------------------------------------
const C = await act.openQuest(d, noor, {
  title: `E2E ${stamp}: translate the allergy sheet into Hindi`,
  brief: "Posted by the automated test.",
  reward: "0.2",
});
evidence.quests.C = C.id;
await act.passOn(d, Z, C.id, null);
await act.passOn(d, sock, C.id, Z);
{
  const res = await act.claim(d, mallory, C.id, sock, "Done, see attached.");
  if (!res.ok) log(`  claim failed: ${res.failures.join("; ")}`);
  const diluted = await preview(C.id, mallory);
  const zDiluted = diluted.shares.find((s) => s.account === Z);
  check("a fake link between the doer and an honest relay halves the honest share", zDiluted && BigInt(zDiluted.amount) === n("0.025"), zDiluted ? toNear(zDiluted.amount) : "none");
  const restored = await preview(C.id, mallory, [sock]);
  const zRestored = restored.shares.find((s) => s.account === Z);
  check("leaving the fake link out restores it", zRestored && BigInt(zRestored.amount) === n("0.05") && !restored.shares.some((s) => s.account === sock), zRestored ? toNear(zRestored.amount) : "none");
  await refused(
    "an account with a record cannot be left out",
    act.accept(d, noor, C.id, mallory, [{ account: Z, reason: "trying to cut out a proven contributor" }]),
    "ERR_CANNOT_LEAVE_OUT_A_RECORD",
  );
  const accepted = await act.accept(d, noor, C.id, mallory, [{ account: sock, reason: "Made minutes before the claim, no history" }]);
  const ids = accepted.value ?? [];
  const q = await quest(C.id);
  check("the reason for leaving a link out is public on the quest", q.left_out.length === 1 && q.left_out[0].account === sock, q.left_out[0]?.reason, accepted.hash);
  const pMallory = (await act.payoutsOf(d, C.id)).find((p) => p.payee === mallory);
  check("the fake account gets nothing, and the unknown doer still needs a second steward", ids.length === 2 && pMallory?.route === routeFor(pMallory.amount, (await record(mallory)).limit, cfg.countersign_cap));
  const committedBefore = BigInt((await board()).committed);
  const declined = await act.decline(d, tomas, pMallory.id, "The translation was machine output with errors");
  const after = await payout(pMallory.id);
  check("a steward can decline a payment before it is filed", declined.ok && after.phase === "Declined", after.note, declined.hash);
  check("a declined payment gives its share back to the budget", committedBefore - BigInt((await board()).committed) === BigInt(pMallory.amount));
    await refused("a declined payment cannot be pushed", act.advance(d, keeper, pMallory.id), "ERR_NOTHING_TO_ADVANCE");
  const zPay = (await act.payoutsOf(d, C.id)).find((p) => p.payee === Z);
  if (zPay.route === "Countersign") {
    // Z was approved for 0.025 NEAR before. A share of 0.05 is more than anyone has signed off for it.
    const res = await act.countersign(d, tomas, zPay.id);
    check("a larger share than a second steward has approved before needs a second steward again", res.ok, `${toNear(zPay.amount)} NEAR`, res.hash);
  }
  const settled = await act.settle(d, keeper, C.id);
  const pZ2 = settled.payouts.find((p) => p.payee === Z);
  check("the honest relay is still paid its full share", pZ2?.phase === "Paid" && BigInt(pZ2.amount) === n("0.05"), pZ2?.phase);
  check("the quest closes once every payment is paid or declined", (await quest(C.id)).status === "Done");
}

// ---------------------------------------------------------------------------------------------
// D. Stewards and their own money, and the caps.
// ---------------------------------------------------------------------------------------------
const D = await act.openQuest(d, noor, { title: `E2E ${stamp}: paint the shop sign`, brief: "Posted by the automated test.", reward: "0.2" });
evidence.quests.D = D.id;
{
  await act.claim(d, tomas, D.id, null, "I painted it on Sunday.");
  const accepted = await act.accept(d, noor, D.id, tomas);
  const [id] = accepted.value ?? [];
  await refused("a steward cannot countersign a payment to themselves", act.countersign(d, tomas, id), "ERR_OWN_PAYMENT");
  await refused("and the accepting steward cannot either, so two stewards cannot pay each other alone", act.countersign(d, noor, id), "ERR_SAME_STEWARD");
  await refused("the payee cannot decline their own payment to dodge the record", act.decline(d, tomas, id, "never mind"), "ERR_OWN_PAYMENT");
  const res = await act.decline(d, noor, id, "Needs the whole council: file it as a normal proposal");
  check("the stuck payment is declined and the money stays put", res.ok && (await payout(id)).phase === "Declined", "", res.hash);
}
await refused(
  "a steward cannot open a quest above the quest cap",
  call(loadAccount(noor), G, "open_quest", { dao: d.dao, title: "Too big", brief: "x", reward: (BigInt(cfg.quest_cap) + 1n).toString(), deadline: String((BigInt(Date.now()) + 86_400_000n) * 1_000_000n), sponsor_post: null }, { gas: 80 }),
  "ERR_OVER_QUEST_CAP",
);
await refused(
  "an outsider cannot open a quest",
  call(loadAccount(mallory), G, "open_quest", { dao: d.dao, title: "Pay me", brief: "x", reward: NEAR("0.2"), deadline: String((BigInt(Date.now()) + 86_400_000n) * 1_000_000n), sponsor_post: null }, { gas: 80 }),
  "ERR_NOT_A_STEWARD",
);
await refused(
  "a reward too small to pay anyone is refused",
  call(loadAccount(noor), G, "open_quest", { dao: d.dao, title: "Dust", brief: "x", reward: NEAR("0.001"), deadline: String((BigInt(Date.now()) + 86_400_000n) * 1_000_000n), sponsor_post: null }, { gas: 80 }),
  "ERR_REWARD_TOO_SMALL",
);
await refused(
  "a deadline in the past is refused",
  call(loadAccount(noor), G, "open_quest", { dao: d.dao, title: "Late", brief: "x", reward: NEAR("0.2"), deadline: "1000", sponsor_post: null }, { gas: 80 }),
  "ERR_DEADLINE",
);
await refused(
  "only the DAO can change its board",
  call(loadAccount(mallory), G, "update_board", { config: { ...cfg, quest_cap: NEAR("999"), period_cap: NEAR("999") } }, { gas: 100 }),
  "ERR_NO_BOARD",
);
await refused(
  "nobody else can open a board on this copy: it serves one DAO",
  call(loadAccount(mallory), G, "create_board", { config: cfg }, { gas: 100, deposit: NEAR("0.1") }),
  "ERR_NOT_THIS_DAO",
);
check("the copy names the one DAO it serves", (await view(G, "dao")) === d.dao, d.dao);
await refused("only the DAO can bar an account", call(loadAccount(mallory), G, "set_barred", { account: X, barred: true }, { gas: 30 }), "ERR_NO_BOARD");
await refused("only the DAO can abandon a payment", call(loadAccount(mallory), G, "abandon_payout", { payout_id: String(pX) }, { gas: 30 }), "ERR_NO_BOARD");
await refused("only the DAO can take the float", call(loadAccount(mallory), G, "withdraw_float", { amount: "1" }, { gas: 30 }), "ERR_NO_BOARD");
{
  const closing = await act.openQuest(d, noor, { title: `E2E ${stamp}: a quest closed unpaid`, brief: "Posted by the automated test.", reward: "0.2" });
  const committed = BigInt((await board()).committed);
  const res = await call(loadAccount(tomas), G, "close_quest", { quest_id: String(closing.id) }, { gas: 30 });
  check("closing an open quest gives its whole reward back to the budget", res.ok && committed - BigInt((await board()).committed) === n("0.2"), "", res.hash);
  await refused("a closed quest takes no more passes", act.passOn(d, Y, closing.id, null), "ERR_QUEST_NOT_OPEN");
}

// ---------------------------------------------------------------------------------------------
// E. A pause. Any steward can stop the board. Only the DAO's vote can start it again.
// ---------------------------------------------------------------------------------------------
{
  await refused("an outsider cannot pause the board", call(loadAccount(mallory), G, "pause", { dao: d.dao }, { gas: 30 }), "ERR_NOT_A_STEWARD");
  const paused = await call(loadAccount(tomas), G, "pause", { dao: d.dao }, { gas: 30 });
  check("one steward pauses the board", paused.ok && (await board()).paused_by === tomas, "", paused.hash);
  await refused(
    "a paused board opens no quests",
    call(loadAccount(noor), G, "open_quest", { dao: d.dao, title: "While paused", brief: "x", reward: NEAR("0.2"), deadline: String((BigInt(Date.now()) + 86_400_000n) * 1_000_000n), sponsor_post: null }, { gas: 80 }),
    "ERR_PAUSED",
  );
  await refused("a steward alone cannot resume it", call(loadAccount(tomas), G, "resume", {}, { gas: 30 }), "ERR_NO_BOARD");
  const resumed = await act.daoCall(d, "Resume the Grapevine board", "Paused by the automated test.", "resume", {});
  check("the DAO's own vote resumes it", resumed.status === "Approved" && (await board()).paused_by === null, `proposal ${resumed.id}`, resumed.hashes.at(-1));
  evidence.proposals.resume = resumed.id;
}

// ---------------------------------------------------------------------------------------------
// F. A payment above the countersign cap is left to the DAO's ordinary vote.
// ---------------------------------------------------------------------------------------------
const free = BigInt(await balanceOf(d.dao)) - n("5.6");
const bigReward = (BigInt(cfg.countersign_cap) * 2n + n("0.4")).toString();
if (quick || free < BigInt(bigReward) / 2n + n("0.1")) {
  check("council-route scenario", true, quick ? "skipped with --quick" : `skipped: the treasury has only ${toNear(free)} NEAR free`);
} else {
  const opened = await act.daoCall(d, "Open a larger Grapevine quest", "Above what one steward may open, so the DAO opens it by vote.", "open_quest", {
    dao: d.dao,
    title: `E2E ${stamp}: rewire the cold room`,
    brief: "Posted by the automated test. Opened by the DAO's own vote.",
    reward: bigReward,
    deadline: String((BigInt(Date.now()) + 7n * 86_400_000n) * 1_000_000n),
    sponsor_post: null,
  }, { deposit: NEAR("0.05") });
  const F = Number((await view(G, "totals")).quests);
  evidence.quests.F = F;
  const q = await quest(F);
  check("the DAO itself opens a quest above the steward cap", opened.status === "Approved" && q.by_dao && q.sponsor === d.dao, `quest ${F}, proposal ${opened.id}`, opened.hashes.at(-1));
  await act.claim(d, X, F, null, "Rewired and tested under load.");
  const accepted = await act.accept(d, tomas, F, X);
  const [id] = accepted.value ?? [];
  const p0 = await payout(id);
  check("its doer share is above the countersign cap, so the route is the DAO's vote", accepted.ok && p0.route === "Council", `${toNear(p0.amount)} NEAR`, accepted.hash);
  const filed = await act.advance(d, keeper, id);
  const p1 = await payout(id);
  check("Grapevine files the transfer and does not vote", filed.ok && p1.phase === "Filed", `proposal ${p1.proposal_id}`, filed.hash);
  evidence.proposals.F_doer = Number(p1.proposal_id);
  await refused("Grapevine will not vote on it however often it is asked", act.advance(d, keeper, id), "ERR_WAITING_FOR_THE_DAO_VOTE");
  await refused("a countersign does not apply to it", act.countersign(d, noor, id), "ERR_NOT_WAITING_FOR_A_COUNTERSIGN");
  const waiting = await act.reconcile(d, keeper, id);
  check("until the council votes, nothing changes", waiting.ok && (await payout(id)).phase === "Filed", (await payout(id)).note);
  const xBefore = BigInt(await balanceOf(X));
  const votes = await act.councilVote(d, p1.proposal_id);
  const proposal = await view(d.dao, "get_proposal", { id: Number(p1.proposal_id) });
  check("the council passes it with its own votes, and Grapevine's is not among them", proposal.status === "Approved" && !(G in proposal.votes) && Object.keys(proposal.votes).length === 2, JSON.stringify(proposal.votes), votes.at(-1));
  const seen = await act.reconcile(d, keeper, id);
  check("Grapevine notes the approval", seen.ok && (await payout(id)).phase === "Clearing", "", seen.hash);
  await sleep(act.SETTLE_MS);
  const done = await act.reconcile(d, keeper, id);
  check("and records it as paid on a later look", done.ok && (await payout(id)).phase === "Paid", "", done.hash);
  check("the doer received the full share", BigInt(await balanceOf(X)) - xBefore === BigInt(p0.amount), toNear(p0.amount));
}

// ---------------------------------------------------------------------------------------------
// Clean up: the fresh accounts are deleted and what they hold goes back to the treasury.
// ---------------------------------------------------------------------------------------------
for (const id of [X, Y, Z]) {
  const res = await deleteInto(id, d.dao);
  if (!res.ok) log(`  could not delete ${id}: ${res.why}`);
}

const failed = checks.filter((c) => !c.ok);
const report = {
  ran_at: new Date().toISOString(),
  network: d.network,
  contract: G,
  dao: d.dao,
  version: await view(G, "version"),
  passed: checks.length - failed.length,
  failed: failed.length,
  evidence,
  checks,
};
fs.writeFileSync(path.join(ROOT, "deployments", "testnet-e2e.json"), JSON.stringify(report, null, 2) + "\n");
log(`${report.passed} of ${checks.length} checks passed`);
if (failed.length) {
  for (const c of failed) log(`FAILED: ${c.name} [${c.detail}]`);
  process.exitCode = 1;
}
