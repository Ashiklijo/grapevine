// What people do on a Grapevine board, as functions. The end-to-end test, the seeding script and
// the demo server all go through these, so a click in the demo is the same call the test makes.
import { NEAR, b64, call, loadAccount, mustCall, sleep, toNear, trezuDescription, view } from "./lib.mjs";
import { postArgs, postRef, writeSocial } from "./social.mjs";

export const SETTLE_MS = 21_000;

export const questLink = (d, questId, via) => {
  if (!d.site) return "";
  return `${d.site}#quest/${questId}${via ? `?via=${via}` : ""}`;
};

/** The words a sponsor posts. Kept in one place so the app and the scripts say the same thing. */
export function sponsorText({ title, brief, reward, dao, link }) {
  return [
    title,
    "",
    brief,
    "",
    `Reward: ${reward} NEAR from the treasury of @${dao}. Whoever gets it done is paid, and so is everyone who passed the word along.`,
    `Know someone? Pass it on.${link ? ` ${link}` : ""} #grapevine`,
  ].join("\n");
}

export function passText({ title, reward, link, note, mentions = [] }) {
  const lead = note || `Passing this on: ${title}`;
  const cc = mentions.length ? ` cc ${mentions.map((m) => `@${m}`).join(" ")}` : "";
  return `${lead}\n\n${reward} NEAR for whoever gets it done, and a share for each of us who passed the word.${link ? ` ${link}` : ""}${cc} #grapevine`;
}

/** Publish one near.social post from an account. Returns its reference. */
export async function socialPost(account, { text, quote, replyTo, root }) {
  const { id, args } = postArgs({ text, quote, replyTo, root });
  const hash = await writeSocial(account, args);
  return { ref: postRef(account.accountId, id), id, hash };
}

const deadlineNs = (days) => ((BigInt(Date.now()) + BigInt(Math.round(days * 86_400_000))) * 1_000_000n).toString();

/** A steward opens a quest. With `withPost`, they first post about it from their own account. */
export async function openQuest(d, stewardId, { title, brief, reward, days = 7, withPost = false }) {
  const steward = loadAccount(stewardId);
  let sponsorPost = null;
  let postHash = null;
  if (withPost) {
    const next = Number((await view(d.contract, "totals")).quests) + 1;
    const post = await socialPost(steward, { text: sponsorText({ title, brief, reward, dao: d.dao, link: questLink(d, next) }) });
    sponsorPost = post.ref;
    postHash = post.hash;
  }
  const res = await mustCall(
    steward,
    d.contract,
    "open_quest",
    { dao: d.dao, title, brief, reward: NEAR(reward), deadline: deadlineNs(days), sponsor_post: sponsorPost },
    // Whoever opens a quest pays for its storage, about a cent. The rest of the deposit comes back.
    { gas: 80, deposit: NEAR("0.05") },
  );
  return { id: res.value, hash: res.hash, sponsorPost, postHash };
}

/** The post a pass should quote: the parent's own post, else the sponsor's, else the contract's. */
export async function parentPost(d, questId, via) {
  const quest = await view(d.contract, "get_quest", { quest_id: String(questId) });
  if (via) {
    const link = await view(d.contract, "get_link", { quest_id: String(questId), account: via });
    if (link?.post) return link.post;
  }
  return quest.sponsor_post || quest.post || null;
}

/** Pass a quest on: optionally post about it, then record who you heard it from. */
export async function passOn(d, accountId, questId, via = null, { withPost = false, note, mentions } = {}) {
  const account = loadAccount(accountId);
  let post = null;
  let postHash = null;
  if (withPost) {
    const quest = await view(d.contract, "get_quest", { quest_id: String(questId) });
    const published = await socialPost(account, {
      text: passText({ title: quest.title, reward: toNear(quest.reward), link: questLink(d, questId, accountId), note, mentions }),
      quote: await parentPost(d, questId, via),
    });
    post = published.ref;
    postHash = published.hash;
  }
  const res = await call(account, d.contract, "pass_on", { quest_id: String(questId), via, post }, { gas: 40, deposit: NEAR("0.01") });
  return { ...res, post, postHash };
}

export async function claim(d, accountId, questId, via, note, { withPost = false } = {}) {
  const account = loadAccount(accountId);
  let post = null;
  let postHash = null;
  if (withPost) {
    const root = await parentPost(d, questId, null);
    const published = await socialPost(account, { text: note, replyTo: root, root });
    post = published.ref;
    postHash = published.hash;
  }
  const res = await call(account, d.contract, "claim", { quest_id: String(questId), via, note, post }, { gas: 40, deposit: NEAR("0.01") });
  return { ...res, post, postHash };
}

// Whoever accepts a claim pays for the storage of the payments it creates. The rest comes back.
export const accept = (d, stewardId, questId, doer, leaveOut = []) =>
  call(loadAccount(stewardId), d.contract, "accept", { quest_id: String(questId), doer, leave_out: leaveOut }, { gas: 150, deposit: NEAR("0.1") });

export const countersign = (d, stewardId, payoutId) =>
  call(loadAccount(stewardId), d.contract, "countersign", { payout_id: String(payoutId) }, { gas: 300 });

export const decline = (d, stewardId, payoutId, reason) =>
  call(loadAccount(stewardId), d.contract, "decline", { payout_id: String(payoutId), reason }, { gas: 60 });

export const advance = (d, callerId, payoutId) =>
  call(loadAccount(callerId), d.contract, "advance", { payout_id: String(payoutId) }, { gas: 300 });

export const reconcile = (d, callerId, payoutId) =>
  call(loadAccount(callerId), d.contract, "reconcile", { payout_id: String(payoutId) }, { gas: 200 });

export const payoutsOf = (d, questId) => view(d.contract, "list_payouts", { quest_id: String(questId) });

const FINAL = new Set(["Paid", "Declined"]);

/**
 * What a keeper does: push every payment of a quest as far as it can go without a person.
 * Anyone may make these calls. Returns the payments, and which ones are waiting on someone.
 */
export async function settle(d, keeperId, questId, { timeoutMs = 120_000, onStep = () => {} } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const payouts = await payoutsOf(d, questId);
    const waiting = [];
    let moved = false;
    let clearing = false;
    for (const p of payouts) {
      if (FINAL.has(p.phase)) continue;
      const mayVote = p.route === "Auto" || p.countersigned_by;
      if (p.phase === "Pending" && (p.route !== "Countersign" || mayVote)) {
        onStep(`filing payment ${p.id} for ${p.payee}`);
        const res = await advance(d, keeperId, p.id);
        if (!res.ok) waiting.push({ id: p.id, why: res.failures.join("; ") });
        else moved = true;
      } else if (p.phase === "Pending") {
        waiting.push({ id: p.id, why: "needs a countersign" });
      } else if (p.phase === "Filed" && mayVote) {
        const res = await advance(d, keeperId, p.id);
        if (!res.ok) waiting.push({ id: p.id, why: res.failures.join("; ") });
        else moved = true;
      } else if (p.phase === "Filed" || p.phase === "Voted" || p.phase === "Clearing") {
        const sinceMs = Number(BigInt(p.since) / 1_000_000n);
        if (p.phase !== "Filed" && Date.now() < sinceMs + SETTLE_MS) {
          clearing = true;
          continue;
        }
        const res = await reconcile(d, keeperId, p.id);
        const after = await view(d.contract, "get_payout", { payout_id: p.id });
        if (after.phase !== p.phase) moved = true;
        if (after.phase === "Filed" && p.route === "Council") waiting.push({ id: p.id, why: "needs the DAO's vote" });
        else if (!FINAL.has(after.phase)) clearing = true;
        if (!res.ok) onStep(`reconcile ${p.id}: ${res.failures.join("; ")}`);
      } else {
        clearing = true; // Filing or Voting: a call is in flight.
      }
    }
    const open = (await payoutsOf(d, questId)).filter((p) => !FINAL.has(p.phase));
    if (!open.length) return { payouts: await payoutsOf(d, questId), waiting: [] };
    if (!moved && !clearing) return { payouts: await payoutsOf(d, questId), waiting };
    if (Date.now() > until) return { payouts: await payoutsOf(d, questId), waiting, timedOut: true };
    await sleep(moved ? 1500 : 4000);
  }
}

/** File a proposal on the DAO as one council member and pass it with the council's votes. */
export async function daoDecide(d, description, kind, { voters = d.people.council, action = "VoteApprove" } = {}) {
  const policy = await view(d.dao, "get_policy");
  const filed = await mustCall(loadAccount(voters[0]), d.dao, "add_proposal", { proposal: { description, kind } }, { gas: 60, deposit: policy.proposal_bond });
  const id = filed.value;
  const hashes = [filed.hash];
  for (const voter of voters) {
    const { status } = await view(d.dao, "get_proposal", { id });
    if (status !== "InProgress") break;
    const res = await mustCall(loadAccount(voter), d.dao, "act_proposal", { id, action, proposal: kind }, { gas: 270 });
    hashes.push(res.hash);
  }
  const { status } = await view(d.dao, "get_proposal", { id });
  return { id, status, hashes };
}

/** A FunctionCall proposal that has the DAO itself call Grapevine. */
export const daoCall = (d, title, notes, method, args, { deposit = "0", gas = "100000000000000" } = {}) =>
  daoDecide(d, trezuDescription(title, notes), {
    FunctionCall: { receiver_id: d.contract, actions: [{ method_name: method, args: b64(args), deposit, gas }] },
  });

/** Cast the council's votes on a proposal that already exists, such as a council-route payment. */
export async function councilVote(d, proposalId, action = "VoteApprove") {
  const hashes = [];
  for (const voter of d.people.council) {
    const proposal = await view(d.dao, "get_proposal", { id: Number(proposalId) });
    if (proposal.status !== "InProgress") break;
    const res = await mustCall(loadAccount(voter), d.dao, "act_proposal", { id: Number(proposalId), action, proposal: proposal.kind }, { gas: 270 });
    hashes.push(res.hash);
  }
  return hashes;
}
