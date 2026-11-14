// The Grapevine site. Static: it reads the contract over public RPC and near.social over FastData.
// In demo mode the local server adds buttons that act as the demo community's members.
import { ago, esc, fallbackName, left, loadConfig, makeChain, near, nsToMs, toYocto } from "./chain.js";
import { makeSocial, parseRef } from "./social.js";
import { colorOf, drawVine, initials } from "./vine.js";

const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");
const S = { cfg: null, chain: null, social: null, me: null, profiles: new Map(), daoName: "", timer: null, view: null, sig: "", open: new Map() };

const g = (method, args = {}) => S.chain.view(S.cfg.contract, method, args);
const q = (id) => String(id);

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

async function learn(accounts) {
  const missing = [...new Set(accounts)].filter((a) => a && !S.profiles.has(a));
  if (!missing.length) return;
  try {
    for (const [account, profile] of await S.social.profiles(missing)) S.profiles.set(account, profile);
  } catch {
    for (const a of missing) S.profiles.set(a, { account: a, name: null, about: null, avatar: null });
  }
}

function nameOf(account) {
  if (account === S.cfg.dao) return S.daoName;
  if (account === S.cfg.contract) return "Grapevine";
  return S.profiles.get(account)?.name || fallbackName(account);
}

function face(account, size = 34) {
  const name = nameOf(account);
  const picture = S.profiles.get(account)?.avatar;
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px;background:${account === S.cfg.dao ? "#1d1b16" : colorOf(account)}`;
  return picture
    ? `<img class="face" src="${esc(picture)}" alt="" style="width:${size}px;height:${size}px" />`
    : `<span class="face" style="${style}" aria-hidden="true">${esc(initials(name))}</span>`;
}

const who = (account, size) =>
  `<span class="who-inline" title="${esc(account)}">${face(account, size)}<span><b>${esc(nameOf(account))}</b><small>${esc(account)}</small></span></span>`;

// ---------------------------------------------------------------------------------------------
// Demo actions
// ---------------------------------------------------------------------------------------------

function toast(html, kind = "ok", ms = 7000) {
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.innerHTML = html;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), ms);
}

async function act(action, args, as = S.me?.key) {
  const res = await fetch("api/act", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ as, action, args }),
  });
  return res.json();
}

/** Run a demo action from a button, with the button showing that it is busy. */
async function press(button, action, args, done) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Sending to NEAR…";
  try {
    const out = await act(action, args);
    if (out.ok) {
      toast(`${esc(done)} <a href="${esc(out.url)}" target="_blank" rel="noopener">See the transaction</a>`);
    } else {
      toast(`The contract refused: <code>${esc(out.refusal)}</code>${out.url ? ` <a href="${esc(out.url)}" target="_blank" rel="noopener">See the transaction</a>` : ""}`, "bad", 12000);
    }
    await refresh(true);
    return out;
  } catch (err) {
    toast(`Could not reach the demo server: ${esc(err.message)}`, "bad");
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

const ORDINAL = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];
const partText = (p) => (p.part === "Doer" ? "for getting it done" : `for passing it on, ${ORDINAL[p.hop]} from the doer`);

function routeText(route, limit, room) {
  if (route === "Auto") return `Paid at once: inside the ${near(room)} NEAR left of their earned limit this period`;
  if (route === "Countersign") {
    if (BigInt(limit) === 0n) return "First payment to this account: a second steward must countersign";
    return `Over the ${near(room)} NEAR left of their ${near(limit)} NEAR limit this period: a second steward must countersign`;
  }
  return "Above the countersign cap: the DAO's ordinary vote decides";
}

function phaseText(p) {
  switch (p.phase) {
    case "Pending":
      if (p.route === "Countersign" && !p.countersigned_by) return ["wait", "Waiting for a second steward"];
      return ["busy", p.route === "Council" ? "Being filed for the DAO's vote" : "Being filed on the DAO"];
    case "Filing":
      return ["busy", "Filing a transfer on the DAO"];
    case "Filed":
      return p.route === "Council" ? ["wait", "Waiting for the DAO's vote"] : ["busy", "Filed, voting next"];
    case "Voting":
      return ["busy", "Grapevine is voting"];
    case "Voted":
    case "Clearing":
      return ["busy", "Approved. Confirming the transfer ran"];
    case "Paid":
      return ["paid", "Paid from the treasury"];
    default:
      return ["no", "Declined. The money stayed in the treasury"];
  }
}

const statusChip = (quest) => {
  const map = { Open: ["open", "Open"], Settling: ["busy", "Paying out"], Done: ["paid", "Done"], Closed: ["no", "Closed unpaid"] };
  const [cls, label] = map[quest.status];
  return `<span class="chip chip-${cls}">${label}</span>`;
};

// ---------------------------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------------------------

function chrome() {
  const here = location.hash.slice(1).split("/")[0] || "board";
  const tabs = [
    ["board", "Board"],
    ["records", "Records"],
    ["install", "Install"],
    ...(S.cfg.demo ? [["cheat", "Try to cheat"]] : []),
    ["limits", "Limits"],
  ];
  $("#nav").innerHTML = tabs.map(([id, label]) => `<a href="#${id}" class="${here === id || (here === "quest" && id === "board") || (here === "record" && id === "records") ? "on" : ""}">${label}</a>`).join("");
  $("#strip").innerHTML = `<div class="strip">${
    S.cfg.demo ? "Demo community on NEAR testnet. Test tokens only, and the people are invented. Every button sends a real transaction." : `Live on NEAR ${esc(S.cfg.network)}. Test tokens only.`
  }</div>`;
  if (!S.cfg.demo) {
    $("#who").innerHTML = "";
    return;
  }
  $("#who").innerHTML = `<label class="picker"><span>You are</span>
    <select id="persona">${S.cfg.personas.map((p) => `<option value="${esc(p.key)}" ${S.me?.key === p.key ? "selected" : ""}>${esc(p.name)} · ${esc(p.role)}</option>`).join("")}</select>
  </label>`;
}

// ---------------------------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------------------------

async function loadBoard() {
  const board = await g("get_board", { dao: S.cfg.dao });
  if (!board) throw new Error("ERR_NO_BOARD");
  const from = Math.max(0, board.quests - 40);
  const [quests, treasury, people] = await Promise.all([
    g("list_quests", { dao: S.cfg.dao, from_index: from, limit: 40 }),
    S.chain.spendable(S.cfg.dao),
    g("list_people", { dao: S.cfg.dao, from_index: 0, limit: 100 }),
  ]);
  await learn([...quests.map((x) => x.sponsor), ...quests.map((x) => x.doer), ...board.stewards]);
  return { board, quests: quests.reverse(), treasury, people };
}

function budgetLeft(board) {
  const cfg = board.config;
  const over = Date.now() >= nsToMs(board.period_started) + nsToMs(cfg.period_ns);
  const committed = over ? 0n : BigInt(board.committed);
  const cap = BigInt(cfg.period_cap);
  return committed >= cap ? 0n : cap - committed;
}

const days = (ns) => Math.round(nsToMs(ns) / 86_400_000);

function questCard(quest) {
  const about = quest.status === "Open" ? `${quest.links} on the vine · ${quest.claims} ${quest.claims === 1 ? "claim" : "claims"} · ${left(nsToMs(quest.deadline))}` : quest.doer ? `Done by ${esc(nameOf(quest.doer))} · ${near(quest.paid)} NEAR paid to ${quest.payouts.length} ${quest.payouts.length === 1 ? "person" : "people"}` : "Closed";
  return `<a class="card quest-card" href="#quest/${quest.id}">
    <div class="card-top">${statusChip(quest)}<span class="reward">${near(quest.reward)} <small>NEAR</small></span></div>
    <h3>${esc(quest.title)}</h3>
    <p class="muted">${about}</p>
    <p class="by">${face(quest.sponsor, 22)} <span>${esc(nameOf(quest.sponsor))} · ${ago(nsToMs(quest.opened_at))}</span></p>
  </a>`;
}

async function viewBoard() {
  const { board, quests, treasury, people } = await loadBoard();
  const cfg = board.config;
  const open = quests.filter((x) => x.status === "Open" || x.status === "Settling");
  const past = quests.filter((x) => x.status === "Done" || x.status === "Closed");
  const steward = S.me && board.stewards.includes(S.me.account);
  S.sig = JSON.stringify([quests.map((x) => [x.id, x.status, x.links, x.claims, x.paid]), String(treasury), board.committed]);
  app.innerHTML = `
    <section class="hero">
      <div>
        <p class="eyebrow">${esc(S.daoName)} · <span title="${esc(S.cfg.dao)}">${esc(S.cfg.dao)}</span></p>
        <h1>Someone you know knows someone.</h1>
        <p class="lede">This community posts what it needs and what its treasury will pay. Pass a quest on to someone who might help.
        When it gets done, the treasury pays the person who did it, and everyone who passed the word along to reach them.</p>
      </div>
      <dl class="stats">
        <div><dt>In the treasury</dt><dd>${near(treasury ?? 0n, 2)} <small>NEAR</small></dd></div>
        <div><dt>Budget left this ${days(cfg.period_ns) === 7 ? "week" : `${days(cfg.period_ns)} days`}</dt><dd>${near(budgetLeft(board), 2)} <small>NEAR</small></dd></div>
        <div><dt>Paid so far</dt><dd>${near(board.paid, 2)} <small>NEAR</small></dd></div>
        <div><dt>People with a record</dt><dd>${people.filter((p) => p.points > 0).length}</dd></div>
      </dl>
    </section>
    <section class="how">
      <div><b>1</b><span>A steward opens a quest. The reward stays in the DAO's treasury.</span></div>
      <div><b>2</b><span>Anyone passes it on. Each pass records who they heard it from.</span></div>
      <div><b>3</b><span>The doer gets half. Each person back up the chain gets half of the one below.</span></div>
      <div><b>4</b><span>Each payment is a DAO transfer, approved by a rule the council set.</span></div>
    </section>
    ${board.paused_by ? `<p class="banner">This board is paused by ${esc(nameOf(board.paused_by))}. Only the DAO's vote can resume it.</p>` : ""}
    ${steward ? openForm(cfg) : ""}
    <h2>Open quests</h2>
    <div class="grid">${open.map(questCard).join("") || `<p class="muted">Nothing open right now.</p>`}</div>
    <h2>Finished</h2>
    <div class="grid">${past.map(questCard).join("") || `<p class="muted">Nothing finished yet.</p>`}</div>`;
}

const openForm = (cfg) => `
  <details class="card open-form">
    <summary>Open a quest <small>You are a steward, so you can open one up to ${near(cfg.quest_cap)} NEAR without a vote</small></summary>
    <form data-form="open">
      <label>What do you need?<input name="title" maxlength="100" required placeholder="Find a sign-language interpreter for Saturday's members' meeting" /></label>
      <label>The details<textarea name="brief" maxlength="600" required rows="3" placeholder="When, where, and what counts as done."></textarea></label>
      <label class="narrow">Reward in NEAR<input name="reward" inputmode="decimal" required value="2" /></label>
      <button class="primary">Open the quest and post it</button>
      <p class="muted">This posts from your account on near.social and opens the quest on NEAR. The reward stays in the treasury until someone is paid.</p>
    </form>
  </details>`;

// ---------------------------------------------------------------------------------------------
// One quest
// ---------------------------------------------------------------------------------------------

async function loadQuest(id) {
  const quest = await g("get_quest", { quest_id: q(id) });
  if (!quest) throw new Error("ERR_NO_QUEST");
  const [board, links, claims, payouts] = await Promise.all([
    g("get_board", { dao: quest.dao }),
    g("list_links", { quest_id: q(id), from_index: 0, limit: 100 }),
    g("list_claims", { quest_id: q(id), from_index: 0, limit: 100 }),
    g("list_payouts", { quest_id: q(id) }),
  ]);
  const accounts = [quest.sponsor, ...links.map((l) => l.account), ...payouts.flatMap((p) => [p.accepted_by, p.countersigned_by]), ...board.stewards];
  if (S.me) accounts.push(S.me.account);
  await learn(accounts);
  return { quest, board, links, claims, payouts };
}

async function loadPosts({ quest, links, claims }) {
  const refs = [quest.sponsor_post, quest.post, ...links.map((l) => l.post), ...claims.map((c) => c.post)].filter(Boolean);
  try {
    const [byRef, own] = await Promise.all([S.social.posts(refs), S.social.recentPosts(S.cfg.contract, 40)]);
    const mine = own.filter((p) => new RegExp(`[Qq]uest #${quest.id}\\b`).test(p.text));
    const all = new Map([...byRef, ...mine.map((p) => [p.ref, p])]);
    await learn([...all.values()].map((p) => p.account));
    return [...all.values()].sort((a, b) => a.at - b.at);
  } catch {
    return null;
  }
}

function postUrl(post) {
  return S.cfg.network === "mainnet"
    ? `https://near.social/${post.account}/post/${post.id}`
    : `https://kv.test.fastnear.com/v0/latest/social/${post.account}/post/${post.id}`;
}

function linkify(text) {
  return esc(text)
    .replace(/(https?:\/\/[^\s<]+)/g, (url) => {
      const here = S.cfg.site && url.startsWith(S.cfg.site) ? url.slice(S.cfg.site.length) : null;
      return `<a href="${here ?? url}"${here ? "" : ' target="_blank" rel="noopener"'}>${url}</a>`;
    })
    .replace(/(^|[^\w@.])@([a-z0-9][a-z0-9._-]{1,63})/g, (m, pre, raw) => {
      const account = raw.replace(/[._-]+$/, "");
      return `${pre}<span class="mention" title="${account}">@${esc(nameOf(account))}</span>${raw.slice(account.length)}`;
    })
    .replace(/\n/g, "<br>");
}

function postsHtml(posts) {
  if (posts === null) return `<p class="muted">near.social could not be read just now.</p>`;
  if (!posts.length) return `<p class="muted">No posts yet.</p>`;
  return posts
    .map(
      (p) => `<article class="post ${p.account === S.cfg.contract ? "post-contract" : ""}">
        ${face(p.account, 30)}
        <div>
          <p class="post-head"><b>${esc(nameOf(p.account))}</b>
            ${p.account === S.cfg.contract ? `<span class="chip chip-auto">written by the contract</span>` : ""}
            <span class="muted">${ago(p.at)}${p.quote ? " · quotes the post it came from" : ""}${p.replyTo ? " · a reply" : ""}</span>
            <a class="raw" href="${esc(postUrl(p))}" target="_blank" rel="noopener">${S.cfg.network === "mainnet" ? "on near.social" : "on FastData"}</a></p>
          <p class="post-text">${linkify(p.text)}</p>
        </div>
      </article>`,
    )
    .join("");
}

function vineHtml({ quest, links, claims, payouts }) {
  const paid = new Map(payouts.map((p) => [p.payee, p]));
  return drawVine({
    sponsor: quest.sponsor,
    links,
    nameOf,
    marks: {
      doer: quest.doer,
      claimed: new Set(claims.map((c) => c.account)),
      paid,
      leftOut: new Set(quest.left_out.map((l) => l.account)),
      me: S.me?.account,
    },
  });
}

function paymentsHtml({ quest, board, payouts }) {
  if (!payouts.length) return "";
  const steward = S.me && board.stewards.includes(S.me.account);
  const rows = payouts
    .map((p) => {
      const [cls, label] = phaseText(p);
      const mine = S.me?.account;
      let buttons = "";
      if (S.cfg.demo && p.phase === "Pending" && p.route === "Countersign" && !p.countersigned_by) {
        if (steward && mine !== p.accepted_by && mine !== p.payee) {
          buttons = `<button class="primary small" data-act="countersign" data-id="${p.id}">Countersign</button>
                     <button class="ghost small" data-act="decline" data-id="${p.id}">Decline</button>`;
        } else if (steward && mine === p.accepted_by) {
          buttons = `<span class="hint">You accepted this claim, so a different steward has to countersign.</span>`;
        } else {
          buttons = `<span class="hint">Switch to another steward to countersign.</span>`;
        }
      }
      const how =
        p.route === "Auto"
          ? "Paid at once: inside their earned limit"
          : p.route === "Countersign"
            ? p.countersigned_by
              ? `Countersigned by ${esc(nameOf(p.countersigned_by))}`
              : "Needs a second steward"
            : "Above the cap: the DAO's ordinary vote";
      return `<li class="pay pay-${cls}">
        ${face(p.payee, 34)}
        <div class="pay-main">
          <p><b>${esc(nameOf(p.payee))}</b> <span class="amount">${near(p.amount)} NEAR</span> <span class="muted">${partText(p)}</span></p>
          <p class="pay-how"><span class="chip chip-${p.route.toLowerCase()}">${how}</span>
             <span class="chip chip-${cls}">${label}</span>
             ${p.proposal_id !== null ? `<button class="linkish" data-act="proposal" data-id="${p.proposal_id}" data-payout="${p.id}" title="Read this proposal from ${esc(quest.dao)}">DAO proposal #${p.proposal_id}</button>` : ""}</p>
          <div class="proposal" id="proposal-${p.id}">${S.open.get(p.id) ?? ""}</div>
          ${p.phase === "Declined" ? `<p class="muted">${esc(p.note)}</p>` : ""}
          ${buttons ? `<p class="pay-buttons">${buttons}</p>` : ""}
        </div>
      </li>`;
    })
    .join("");
  const total = payouts.filter((p) => p.phase !== "Declined").reduce((sum, p) => sum + BigInt(p.amount), 0n);
  const kept = BigInt(quest.reward) - total;
  return `<h3>The payments</h3><ul class="pays">${rows}</ul>
    <p class="muted kept">${near(kept)} NEAR of the ${near(quest.reward)} NEAR reward was not needed and never left the treasury.</p>
    ${quest.left_out.length ? `<p class="muted kept">Left out of the chain by ${esc(nameOf(quest.accepted_by))}: ${quest.left_out.map((l) => `${esc(nameOf(l.account))} (“${esc(l.reason)}”)`).join(", ")}.</p>` : ""}`;
}

/** What the person looking at the quest can do about it. */
async function actionsHtml(data, query) {
  const { quest, board, links, claims } = data;
  const cfg = board.config;
  if (!S.cfg.demo) {
    return `<div class="card"><h3>Take part</h3><p>This page is read-only. To pass this on or claim it from your own testnet account, run
      <code>node scripts/try.mjs &lt;you&gt;.testnet ${quest.id}</code> from the repository, or start the demo with <code>npm run demo</code>.</p></div>`;
  }
  const me = S.me.account;
  const onVine = links.find((l) => l.account === me);
  const myClaim = claims.find((c) => c.account === me);
  const bps = (n) => (BigInt(quest.reward) * BigInt(n)) / 10000n;
  const out = [];

  if (quest.status === "Open" && me === quest.sponsor) {
    out.push(`<div class="card"><h3>Claims on your quest</h3>
      ${
        claims.length
          ? claims
              .map(
                (c) => `<div class="claim">${who(c.account, 30)}<p class="note">“${esc(c.note)}”</p>
                  <button class="primary small" data-act="preview" data-doer="${esc(c.account)}">See the split</button></div>
                  <div class="split" id="split-${esc(c.account).replace(/\./g, "-")}"></div>`,
              )
              .join("")
          : `<p class="muted">Nobody has claimed it yet. ${links.length} ${links.length === 1 ? "person has" : "people have"} passed it on.</p>`
      }
      <p><button class="ghost small" data-act="close" data-id="${quest.id}">Close the quest unpaid</button></p></div>`);
  } else if (quest.status === "Open" && board.stewards.includes(me)) {
    out.push(`<div class="card"><h3>Not your quest</h3><p class="muted">${esc(nameOf(quest.sponsor))} opened this one, so only they can accept a claim on it.
      If a payment needs a second steward, you can countersign it here.</p></div>`);
  } else if (quest.status === "Open") {
    if (myClaim) {
      out.push(`<div class="card"><h3>You claimed this</h3><p class="note">“${esc(myClaim.note)}”</p><p class="muted">${esc(nameOf(quest.sponsor))} decides whether it is done.</p></div>`);
    } else {
      if (!onVine) {
        let via = query.get("via");
        if (!links.some((l) => l.account === via)) via = null;
        let reason = via ? `${nameOf(via)}'s link brought you here` : "";
        if (!via) {
          // Someone you follow who is already on the vine is the likeliest person you heard it from.
          const follows = await S.social.following(me).catch(() => []);
          const known = [...links].reverse().find((l) => follows.includes(l.account));
          if (known) {
            via = known.account;
            reason = `you follow ${nameOf(via)}, who passed this on`;
          }
        }
        const taken = new Set([quest.sponsor, ...links.map((l) => l.account)]);
        const suggestions = (await S.social.suggest(me, `${quest.title} ${quest.brief}`).catch(() => [])).filter((s) => !taken.has(s.account));
        await learn(suggestions.map((s) => s.account));
        out.push(`<div class="card pass">
          <h3>Pass it on</h3>
          <p>Know someone who could do this? If they get it done, the treasury pays you <b>${near(bps(cfg.relay_bps))} NEAR</b> for telling them.
             If it travels further before it is done, each step back gets half.</p>
          <form data-form="pass">
            <label>Who told you?
              <select name="via">
                <option value="">${esc(nameOf(quest.sponsor))}'s own post</option>
                ${links.map((l) => `<option value="${esc(l.account)}" ${l.account === via ? "selected" : ""}>${esc(nameOf(l.account))}</option>`).join("")}
              </select>
            </label>
            ${reason ? `<p class="hint">Filled in because ${esc(reason)}. Your first answer is the one that stands.</p>` : ""}
            ${
              suggestions.length
                ? `<div class="suggest"><p class="muted">People you follow on near.social who might know someone:</p>
                    ${suggestions
                      .map(
                        (s) => `<label class="pick"><input type="checkbox" name="mention" value="${esc(s.account)}" checked />
                          ${face(s.account, 26)}<span><b>${esc(nameOf(s.account))}</b><small>${esc((s.because || "").slice(0, 90))}</small></span></label>`,
                      )
                      .join("")}</div>`
                : ""
            }
            <label>Say it in your own words<textarea name="note" rows="2" maxlength="240">Does anyone know someone for this? ${esc(quest.title)}</textarea></label>
            <button class="primary">Pass it on</button>
            <p class="muted">Posts from your account on near.social, quoting the post you heard it from, and records the link on NEAR.</p>
          </form></div>`);
      } else {
        out.push(`<div class="card"><h3>You passed this on</h3>
          <p>If someone you told gets it done, you are paid <b>${near(bps(cfg.relay_bps))} NEAR</b>. Send them your link:</p>
          <p><code class="link">${esc(S.cfg.site || `${location.origin}${location.pathname}`)}#quest/${quest.id}?via=${esc(me)}</code></p></div>`);
      }
      out.push(`<div class="card">
        <h3>Or do it yourself</h3>
        <p>Whoever gets it done is paid <b>${near(bps(cfg.doer_bps))} NEAR</b>.</p>
        <form data-form="claim">
          <label>What did you do, or how can you help?<textarea name="note" rows="2" maxlength="280" required placeholder="I am free on Saturday and can do this."></textarea></label>
          <button class="primary">I can do this</button>
        </form></div>`);
    }
  }
  return out.join("");
}

/** Read a payment's proposal straight from the DAO, so anyone can check it against what the board says. */
async function showProposal(button) {
  const payout = button.dataset.payout;
  const box = $(`#proposal-${payout}`);
  if (S.open.has(payout)) {
    S.open.delete(payout);
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `<p class="muted">Reading the DAO…</p>`;
  try {
    const proposal = await S.chain.view(S.cfg.dao, "get_proposal", { id: Number(button.dataset.id) });
    const t = proposal.kind.Transfer;
    await learn([...Object.keys(proposal.votes), proposal.proposer, t?.receiver_id].filter(Boolean));
    const votes = Object.entries(proposal.votes).map(([account, vote]) => `${esc(nameOf(account))}: ${esc(vote)}`).join(", ") || "none yet";
    const html = `<dl>
        <dt>On the DAO</dt><dd>${esc(S.cfg.dao)}, proposal ${proposal.id}, read just now</dd>
        <dt>Kind</dt><dd>Transfer of ${near(t.amount)} NEAR to ${esc(t.receiver_id)}</dd>
        <dt>Filed by</dt><dd>${esc(proposal.proposer)}</dd>
        <dt>Status</dt><dd><b>${esc(proposal.status)}</b></dd>
        <dt>Votes</dt><dd>${votes}</dd>
        <dt>Text</dt><dd>${esc(proposal.description).replace("&lt;br&gt;", "<br>")}</dd>
      </dl>`;
    S.open.set(payout, html);
    box.innerHTML = html;
  } catch (err) {
    box.innerHTML = `<p class="muted">Could not read it: ${esc(err.message)}</p>`;
  }
}

async function showSplit(button) {
  const doer = button.dataset.doer;
  const box = $(`#split-${doer.replace(/\./g, "-")}`);
  const leaveOut = [...box.querySelectorAll("input[name=out]:checked")].map((i) => i.value);
  let plan;
  try {
    plan = await g("preview", { quest_id: q(S.view.id), doer, leave_out: leaveOut });
  } catch (err) {
    box.innerHTML = `<p class="banner">The contract would refuse this: <code>${esc(err.message)}</code></p>`;
    return;
  }
  await learn(plan.chain);
  const rows = plan.shares
    .map(
      (s) => `<li>${face(s.account, 28)}<span><span class="line"><b>${esc(nameOf(s.account))}</b> <span class="amount">${near(s.amount)} NEAR</span></span>
        <small>${s.part === "Doer" ? "got it done" : `passed it on, ${ORDINAL[s.hop]} from the doer`} · ${s.points} ${s.points === 1 ? "point" : "points"} on record</small>
        <small class="route-${s.route.toLowerCase()}">${routeText(s.route, s.limit, s.room)}</small></span></li>`,
    )
    .join("");
  const droppable = plan.chain.filter((a) => plan.shares.find((s) => s.account === a)?.points === 0 || leaveOut.includes(a));
  box.innerHTML = `<ul class="shares">${rows}</ul>
    <p class="muted">${near(plan.unspent)} NEAR stays in the treasury.</p>
    ${
      droppable.length
        ? `<div class="leave"><p class="muted">Links with no record can be left out, with a public reason. Links with a record cannot.</p>
          ${droppable
            .map(
              (a) => `<label class="pick"><input type="checkbox" name="out" value="${esc(a)}" ${leaveOut.includes(a) ? "checked" : ""} />
                <span>Leave out <b>${esc(nameOf(a))}</b></span>
                <input type="text" name="reason" data-for="${esc(a)}" maxlength="140" placeholder="Why?" value="${esc(box.querySelector(`input[data-for="${a}"]`)?.value || "")}" /></label>`,
            )
            .join("")}
          <button class="ghost small" data-act="preview" data-doer="${esc(doer)}">Work out the split again</button></div>`
        : ""
    }
    <button class="primary" data-act="accept" data-doer="${esc(doer)}">Accept ${esc(nameOf(doer))}'s claim and pay the chain</button>`;
}

async function viewQuest(id, query) {
  const data = await loadQuest(id);
  const { quest, board } = data;
  S.view = { name: "quest", id, query };
  S.sig = JSON.stringify([quest.status, quest.links, quest.claims, data.payouts.map((p) => [p.phase, p.countersigned_by, p.proposal_id])]);
  app.innerHTML = `
    <p class="crumb"><a href="#board">← The board</a></p>
    <section class="quest">
      <div class="quest-main">
        <div class="card-top">${statusChip(quest)}<span class="reward big">${near(quest.reward)} <small>NEAR</small></span></div>
        <h1>${esc(quest.title)}</h1>
        <p class="lede">${esc(quest.brief)}</p>
        <p class="by">${face(quest.sponsor, 26)} <span>Opened by <b>${esc(nameOf(quest.sponsor))}</b>${quest.by_dao ? ", by the DAO's own vote" : ""} · ${ago(nsToMs(quest.opened_at))}
          ${quest.status === "Open" ? ` · ${left(nsToMs(quest.deadline))}` : ""} · paid from <b>${esc(S.daoName)}</b>'s treasury</span></p>
        <h3>The vine <small>who heard it from whom</small></h3>
        <div class="vine-wrap" id="vine">${vineHtml(data)}</div>
        <h3>On near.social <small>${S.cfg.network === "mainnet" ? "" : "the same standard, on testnet's FastData"}</small></h3>
        <div id="posts"><p class="muted">Reading posts…</p></div>
      </div>
      <aside class="quest-side">
        <div id="actions"></div>
        <div id="payments">${paymentsHtml(data)}</div>
      </aside>
    </section>`;
  $("#actions").innerHTML = await actionsHtml(data, query);
  $("#posts").innerHTML = postsHtml(await loadPosts(data));
  void board;
}

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

async function viewRecords() {
  const [board, people] = await Promise.all([g("get_board", { dao: S.cfg.dao }), g("list_people", { dao: S.cfg.dao, from_index: 0, limit: 100 })]);
  await learn(people.map((p) => p.account));
  const cfg = board.config;
  const rows = people
    .filter((p) => p.points > 0 || p.barred)
    .sort((a, b) => b.points - a.points || Number(BigInt(b.earned) - BigInt(a.earned)))
    .map(
      (p) => `<tr>
        <td><a href="#record/${esc(p.account)}">${who(p.account, 30)}</a></td>
        <td class="num">${p.done}</td><td class="num">${p.carried}</td>
        <td class="num">${near(p.earned)} NEAR</td>
        <td class="num">${p.barred ? `<span class="chip chip-no">barred by the DAO</span>` : `${near(p.limit)} NEAR`}</td>
        <td class="num">${p.barred ? "" : `${near(p.room)} NEAR`}</td>
      </tr>`,
    )
    .join("");
  app.innerHTML = `
    <h1>Records</h1>
    <p class="lede">A record belongs to a named NEAR account. Each point is one payment for one finished quest, and you can open it and follow it to the DAO proposal that paid it.
      Each point raises what that account can be paid in a period without a second steward by ${near(cfg.step)} NEAR, up to ${near(cfg.ceiling)} NEAR, and never above the largest payment a second steward has already approved for it. Anything over what is left of that needs a second steward, and anything above ${near(cfg.countersign_cap)} NEAR needs the DAO's vote.</p>
    <table class="table">
      <thead><tr><th>Who</th><th class="num">Got done</th><th class="num">Passed on</th><th class="num">Earned</th><th class="num">Limit per period</th><th class="num">Left this period</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="muted">Nobody has a record yet.</td></tr>`}</tbody>
    </table>`;
}

async function viewRecord(account) {
  const [record, entries] = await Promise.all([
    g("get_record", { dao: S.cfg.dao, account }),
    g("list_entries", { dao: S.cfg.dao, account, from_index: 0, limit: 100 }),
  ]);
  await learn([account]);
  const quests = new Map();
  for (const e of entries) if (!quests.has(e.quest_id)) quests.set(e.quest_id, await g("get_quest", { quest_id: e.quest_id }));
  const about = S.profiles.get(account)?.about;
  app.innerHTML = `
    <p class="crumb"><a href="#records">← Records</a></p>
    <section class="record-head">${face(account, 64)}<div><h1>${esc(nameOf(account))}</h1><p class="muted">${esc(account)}</p>${about ? `<p>${esc(about)}</p>` : ""}</div></section>
    <dl class="stats inline">
      <div><dt>Got done</dt><dd>${record.done}</dd></div>
      <div><dt>Passed on</dt><dd>${record.carried}</dd></div>
      <div><dt>Earned</dt><dd>${near(record.earned)} <small>NEAR</small></dd></div>
      <div><dt>Left this period, of ${near(record.limit)}</dt><dd>${record.barred ? "barred" : `${near(record.room)} <small>NEAR</small>`}</dd></div>
    </dl>
    <p class="muted">The most a second steward or the DAO's vote has approved for this account in one payment is ${near(record.vouched)} NEAR. It is never paid more than that at once.</p>
    <h2>Where each point came from</h2>
    <ul class="entries">${
      entries
        .map((e) => {
          const quest = quests.get(e.quest_id);
          return `<li><span class="amount">${near(e.amount)} NEAR</span>
            <span>${e.part === "Doer" ? "Got it done" : `Passed it on, ${ORDINAL[e.hop]} from the doer`}: <a href="#quest/${e.quest_id}">${esc(quest?.title ?? `quest ${e.quest_id}`)}</a></span>
            <span class="muted">paid by DAO proposal #${e.proposal_id} · ${ago(nsToMs(e.at))}</span></li>`;
        })
        .join("") || `<li class="muted">No points yet.</li>`
    }</ul>`;
}

// ---------------------------------------------------------------------------------------------
// Install, limits, cheating
// ---------------------------------------------------------------------------------------------

async function viewInstall() {
  const board = await g("get_board", { dao: S.cfg.dao });
  const role = {
    ChangePolicyAddOrUpdateRole: {
      role: {
        name: "grapevine",
        kind: { Group: [S.cfg.contract] },
        permissions: ["transfer:AddProposal", "transfer:VoteApprove", "transfer:Finalize"],
        vote_policy: { transfer: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 1] } },
      },
    },
  };
  const create = {
    FunctionCall: {
      receiver_id: S.cfg.contract,
      actions: [{ method_name: "create_board", args: "base64 of the JSON below", deposit: "300000000000000000000000", gas: "100000000000000" }],
    },
  };
  const yes = (b) => (b ? `<span class="chip chip-paid">yes</span>` : `<span class="chip chip-no">no</span>`);
  app.innerHTML = `
    <h1>Install Grapevine on a Sputnik DAO</h1>
    <p class="lede">Deploy a copy of the contract for your DAO, then pass two ordinary proposals in any Sputnik or Trezu interface. The treasury stays where it is, and nothing is handed over.
      One copy serves one DAO, named when the copy is created: this one answers only to <code>${esc(S.cfg.dao)}</code>.</p>
    <div class="cols">
      <div class="card"><h3>1. Add a role</h3>
        <p>The role holds the Grapevine contract and nothing else, and only these permissions: file a transfer, approve a transfer, close an expired transfer.</p>
        <pre>${esc(JSON.stringify(role, null, 2))}</pre></div>
      <div class="card"><h3>2. Open a board</h3>
        <p>The DAO calls <code>create_board</code> with its own rules. The deposit is a float for proposal bonds and storage. It is never reward money, and the DAO can take it back.</p>
        <pre>${esc(JSON.stringify(create, null, 2))}</pre>
        <pre>${esc(JSON.stringify({ config: board.config }, null, 2))}</pre></div>
    </div>
    <h2>What this board's DAO has granted, read from its policy just now</h2>
    <table class="table narrow-table">
      <tr><td>Grapevine may file transfer proposals</td><td>${yes(board.can_file)}</td></tr>
      <tr><td>Grapevine's vote alone can pass a transfer</td><td>${yes(board.can_approve)}</td></tr>
      <tr><td>Grapevine may close an expired transfer</td><td>${yes(board.can_finalize)}</td></tr>
      <tr><td>Stewards (members of the role “${esc(board.config.steward_role)}”)</td><td>${board.stewards.map((s) => esc(nameOf(s))).join(", ")}</td></tr>
      <tr><td>Float held for bonds and storage</td><td>${near(board.float)} NEAR</td></tr>
    </table>
    <h2>To remove it</h2>
    <p>One proposal: <code>ChangePolicyRemoveRole { "role": "grapevine" }</code>. From that moment the contract can do nothing on the DAO.</p>`;
}

function viewLimits() {
  app.innerHTML = `
    <h1>What Grapevine cannot do, and where it can be fooled</h1>
    <div class="cols">
      <div class="card"><h3>It cannot</h3><ul>
        <li>Hold reward money. Every payment is a transfer straight from the DAO to the payee.</li>
        <li>Vote on anything but a transfer it filed itself, for a payment a steward accepted.</li>
        <li>Open more reward than the DAO's caps, or pay more than a quest's reward.</li>
        <li>Pay a first-time account on one steward's say-so.</li>
        <li>Pay anyone more than their earned limit in a period without a second steward, however many quests one steward accepts.</li>
        <li>Serve a second DAO. Each copy is bound to one DAO when it is deployed, so no stranger's board shares its balance.</li>
        <li>Change its own rules. Only the DAO's vote can, and only for its own board.</li>
      </ul></div>
      <div class="card"><h3>It can be fooled</h3><ul>
        <li><b>A doer can skip the people who told them</b> and claim straight from the sponsor's post. Their own share is the same either way, so there is nothing to gain, but the people skipped lose theirs.</li>
        <li><b>A doer can add accounts of their own</b> to the chain. Those accounts have no record, so they are never paid on one steward's say-so, and the steward accepting the claim can leave them out. A patient cheat who first earns a record with a second account can collect one relay share.</li>
        <li><b>A steward decides what “done” means.</b> Grapevine checks who is paid and how much, not whether the work was good.</li>
        <li><b>Two stewards together</b> can pay anyone up to the countersign cap, inside the period's budget. That is the trust a DAO already places in its council.</li>
        <li><b>A steward stays a steward until someone calls sync.</b> The council is read from the DAO's policy, not on every call. After the council changes, anyone can call <code>sync</code>, and the demo's keeper does.</li>
      </ul></div>
      <div class="card"><h3>Not built or not tested</h3><ul>
        <li>NEAR only. Token rewards are not built.</li>
        <li>One winner per quest.</li>
        <li>Expired proposals: the path that closes them is covered by unit tests, not by a live run, because a testnet proposal takes seven days to expire.</li>
        <li>Posting to near.social runs on testnet's FastData here. The same write on mainnet has not been run.</li>
        <li>Unaudited. Do not point it at a treasury you care about.</li>
      </ul></div>
    </div>`;
}

const CHEATS = [
  ["self_referral", "Name yourself as the person who told you", "So your own second account collects a share.", "ERR_SELF_REFERRAL"],
  ["open_as_outsider", "Open a quest that pays you", "You are not a steward of this DAO.", "ERR_NOT_A_STEWARD"],
  ["accept_as_outsider", "Accept your own claim", "Only the quest's sponsor decides it is done.", "ERR_NOT_A_STEWARD"],
  ["take_the_float", "Take the board's float", "Only the DAO itself can withdraw it.", "ERR_NO_BOARD"],
  ["own_board", "Open a board of your own on this contract", "This copy serves one DAO and no other.", "ERR_NOT_THIS_DAO"],
  ["forge_callback", "Tell the contract a vote succeeded", "Callbacks only answer the contract itself.", "private"],
];

async function viewCheat() {
  const { quests } = await loadBoard();
  const target = quests.find((x) => x.status === "Open") ?? quests[0];
  app.innerHTML = `
    <h1>Try to cheat</h1>
    <p class="lede">Each button sends a real transaction as Mallory, an account with no role. The answer comes from the contract, and you can open the failed transaction.</p>
    ${target ? `<p class="muted">Aimed at quest #${target.id}, “${esc(target.title)}”.</p>` : ""}
    <div class="grid cheats">${CHEATS.map(
      ([kind, title, why]) => `<div class="card cheat"><h3>${title}</h3><p class="muted">${why}</p>
        <button class="ghost" data-act="cheat" data-kind="${kind}" data-quest="${target?.id ?? 1}">Try it</button>
        <p class="verdict" id="verdict-${kind}"></p></div>`,
    ).join("")}</div>
    <p class="muted">The end-to-end test in the repository makes these attempts and about twenty more on every run: <code>npm run e2e</code>.</p>`;
}

// ---------------------------------------------------------------------------------------------
// Routing and events
// ---------------------------------------------------------------------------------------------

async function route() {
  clearInterval(S.timer);
  const raw = location.hash.slice(1) || "board";
  const [path, queryText = ""] = raw.split("?");
  const [name, ...rest] = path.split("/");
  const query = new URLSearchParams(queryText);
  S.view = { name, id: rest.join("/"), query };
  chrome();
  try {
    if (name === "quest") await viewQuest(rest[0], query);
    else if (name === "records") await viewRecords();
    else if (name === "record") await viewRecord(rest.join("/"));
    else if (name === "install") await viewInstall();
    else if (name === "limits") viewLimits();
    else if (name === "cheat" && S.cfg.demo) await viewCheat();
    else await viewBoard();
  } catch (err) {
    app.innerHTML = `<p class="banner">Could not read this from NEAR: <code>${esc(err.message)}</code></p>`;
  }
  window.scrollTo(0, 0);
  if (name === "quest" || name === "board" || !location.hash) S.timer = setInterval(() => refresh(false), 4000);
}

/** Re-read the page's data and redraw only what changed, so nothing you are typing is lost. */
async function refresh(force) {
  try {
    if (S.view?.name === "quest") {
      const data = await loadQuest(S.view.id);
      const sig = JSON.stringify([data.quest.status, data.quest.links, data.quest.claims, data.payouts.map((p) => [p.phase, p.countersigned_by, p.proposal_id])]);
      if (sig === S.sig && !force) return;
      const changedShape = sig !== S.sig;
      S.sig = sig;
      $("#vine").innerHTML = vineHtml(data);
      $("#payments").innerHTML = paymentsHtml(data);
      const typing = document.activeElement && $("#actions").contains(document.activeElement) && /TEXTAREA|INPUT|SELECT/.test(document.activeElement.tagName);
      if (changedShape && !typing) $("#actions").innerHTML = await actionsHtml(data, S.view.query);
      $("#posts").innerHTML = postsHtml(await loadPosts(data));
      const chipHost = $(".quest-main .card-top");
      if (chipHost) chipHost.firstElementChild.outerHTML = statusChip(data.quest);
    } else if (S.view?.name === "board" || !S.view?.name) {
      const { board, quests, treasury } = await loadBoard();
      const sig = JSON.stringify([quests.map((x) => [x.id, x.status, x.links, x.claims, x.paid]), String(treasury), board.committed]);
      if (sig !== S.sig || force) {
        const open = $(".open-form")?.open;
        if (!open) await viewBoard();
      }
    } else if (force) {
      await route();
    }
  } catch {
    // A missed poll is fine: the next one will catch up.
  }
}

document.addEventListener("change", (e) => {
  if (e.target.id === "persona") {
    S.me = S.cfg.personas.find((p) => p.key === e.target.value);
    localStorage.setItem("grapevine-persona", S.me.key);
    route();
  }
});

document.addEventListener("submit", async (e) => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  const data = new FormData(form);
  const button = form.querySelector("button");
  if (form.dataset.form === "open") {
    const out = await press(button, "open_quest", { title: data.get("title"), brief: data.get("brief"), reward: String(data.get("reward")).trim() }, "The quest is open.");
    if (out?.ok) location.hash = `#quest/${out.value}`;
  } else if (form.dataset.form === "pass") {
    await press(button, "pass_on", { quest_id: S.view.id, via: data.get("via") || null, note: data.get("note"), mentions: data.getAll("mention") }, "Passed on. You are on the vine.");
  } else if (form.dataset.form === "claim") {
    await press(button, "claim", { quest_id: S.view.id, via: S.view.query.get("via") || $("select[name=via]")?.value || null, note: data.get("note") }, "Your claim is in.");
  }
});

document.addEventListener("click", async (e) => {
  const button = e.target.closest("button[data-act]");
  if (!button) return;
  const kind = button.dataset.act;
  if (kind === "preview") return showSplit(button);
  if (kind === "proposal") return showProposal(button);
  if (kind === "accept") {
    const box = button.closest(".split");
    const leaveOut = [...box.querySelectorAll("input[name=out]:checked")].map((i) => ({
      account: i.value,
      reason: box.querySelector(`input[data-for="${i.value}"]`)?.value.trim() || "No history with this community",
    }));
    return press(button, "accept", { quest_id: S.view.id, doer: button.dataset.doer, leave_out: leaveOut }, "Accepted. The payments are on their way.");
  }
  if (kind === "countersign") return press(button, "countersign", { payout_id: button.dataset.id }, "Countersigned. Grapevine filed the transfer and voted.");
  if (kind === "decline") return press(button, "decline", { payout_id: button.dataset.id, reason: "Declined in the demo" }, "Declined. The money stays in the treasury.");
  if (kind === "close") return press(button, "close_quest", { quest_id: button.dataset.id }, "Closed.");
  if (kind === "cheat") {
    const verdict = $(`#verdict-${button.dataset.kind}`);
    button.disabled = true;
    verdict.innerHTML = "Sending to NEAR…";
    const out = await act("cheat", { kind: button.dataset.kind, quest_id: button.dataset.quest }, "mallory").catch((err) => ({ ok: false, refusal: err.message }));
    button.disabled = false;
    verdict.innerHTML = out.ok
      ? `<span class="chip chip-no">It went through. That is a bug.</span>`
      : `<span class="chip chip-paid">Refused</span> <code>${esc(out.refusal)}</code> ${out.url ? `<a href="${esc(out.url)}" target="_blank" rel="noopener">the failed transaction</a>` : ""}`;
  }
});

async function boot() {
  S.cfg = await loadConfig();
  if (!S.cfg.deployed) {
    app.innerHTML = `<p class="banner">Grapevine is not deployed yet. Run <code>node scripts/deploy.mjs</code> first.</p>`;
    return;
  }
  S.chain = makeChain(S.cfg.network, S.cfg.rpc);
  S.social = makeSocial(S.cfg.network, (...args) => fetch(...args), S.cfg.kv);
  if (S.cfg.demo) {
    // "?as=bea" opens the demo as that person, so a link can say who to be.
    const asked = new URLSearchParams(location.search).get("as");
    const saved = asked || localStorage.getItem("grapevine-persona");
    S.me = S.cfg.personas.find((p) => p.key === saved) ?? S.cfg.personas[0];
    if (asked) localStorage.setItem("grapevine-persona", S.me.key);
  }
  try {
    const config = await S.chain.view(S.cfg.dao, "get_config");
    S.daoName = config.purpose.includes(":") ? config.purpose.split(":")[0] : fallbackName(S.cfg.dao);
  } catch {
    S.daoName = fallbackName(S.cfg.dao);
  }
  window.addEventListener("hashchange", route);
  await route();
}

boot();
