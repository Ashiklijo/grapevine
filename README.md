# Grapevine

Word-of-mouth quests for Sputnik DAOs on NEAR.

A DAO's steward posts what the community needs and what the treasury will pay for it. Anyone can pass the quest on, and each pass records who they heard it from. When the quest is done, the treasury pays the person who did it and everyone on the chain that carried the word to them.

- **Track:** Social Money (`social`)
- **Built on:** Sputnik DAO v2, Trezu's proposal format, NEAR named accounts, near.social (FastData KV)
- **Network:** NEAR testnet
- **Contract:** `v1.grapevine-hq.testnet` · **Demo DAO:** `riverside-coop.sputnikv2.testnet`
- **Built at:** NEAR HACKATHON, 1 to 14 November 2026
- **Live board, read-only:** https://ashiklijo.github.io/grapevine/ (GitHub Pages, reading testnet and FastData straight from your browser)
- **Demo video:** [`demo/grapevine-demo.mp4`](demo/grapevine-demo.mp4), recorded from the real site against the live testnet contract

## The problem

A bounty reaches the people who already read the board it is posted on. What a community needs is usually known by someone two or three introductions away, and nothing pays for the introductions.

`scripts/census.py` reads every DAO made by the mainnet factory `sputnik-dao.near` and counts the bounties posted with Sputnik's built-in bounty feature. Result on 2026-11-11:

| Measure | Result |
|---|---|
| DAOs read | 2,122 |
| DAOs that ever posted a bounty | 77 |
| Bounties posted | 215 |
| ... done every time they were offered | 60 |
| ... that still have slots nobody was paid for | **155 (72%)** |
| DAOs where no bounty was ever finished | 59 of the 77 |

How to read it: a Sputnik bounty has `times` slots, each approved `BountyDone` proposal pays one, and the `times` a DAO reports is the number left. Zero means the bounty was done every time it was offered. A bounty with slots left may have been done some of the times it was offered, so "unfinished" here means at least one slot was never paid. The numbers include DAOs made for testing. `bridge-validator.sputnik-dao.near` is left out, because its proposals are filed by software. The summary is in [`data/bounties-summary.json`](data/bounties-summary.json).

This measures Sputnik's own bounty feature, which pays one claimer after a full vote and reaches whoever is watching the DAO. It does not prove why those bounties went unfinished. Grapevine is a bet on one reason: the right person never heard about them.

## How it works

1. **Install.** A copy of Grapevine is deployed for the DAO. One copy serves one DAO, named when the copy is created, and nothing else can open a board on it. The DAO's council then passes two ordinary proposals. One adds a role that holds only that contract and only transfer permissions. The other calls `create_board` with the DAO's own rules.
2. **Open.** A steward (a member of the DAO's council, read from the DAO's own policy) opens a quest with a reward, inside the caps the DAO set. The reward stays in the treasury.
3. **Pass it on.** Anyone calls `pass_on` and says who they heard it from. The first answer stands. The app also posts it from their account on near.social, quoting the post it came from, and suggests who to tell from the people they follow.
4. **Claim.** Whoever can do it calls `claim`.
5. **Accept.** The quest's sponsor accepts a claim. The contract splits the reward:
   - half to the doer;
   - a quarter to the account that told the doer, an eighth to the one before, and so on for up to five accounts;
   - what is left is never taken from the treasury.
6. **Pay.** Each share is an ordinary `Transfer` proposal on the DAO, filed by Grapevine. Who approves it depends on the payee's record:

   | The payment is | Route | Who approves |
   |---|---|---|
   | inside what is left of the payee's earned limit for the period | Auto | Grapevine's vote, at once |
   | above it, up to the countersign cap | Countersign | a second steward, who is neither the one who accepted nor the payee |
   | above the countersign cap | Council | the DAO's ordinary vote. Grapevine files it and never votes. |

7. **Record.** Each paid payment adds one point to the payee's record on that board. Each point raises their earned limit by one step, and the limit never exceeds the largest payment a second steward or the DAO's vote has approved for that account. A new account has a limit of zero, so a first payment always needs a second steward. The limit is an allowance for the whole budget period, not per payment: however many quests one steward accepts, the same account is not paid past its limit in a period without a second steward.

The split is the one MIT used to win DARPA's Network Challenge in 2009 ([Pickard et al., Science, 2011](https://www.science.org/doi/10.1126/science.1205869)). Design details, the answer to "which approval flows already exist and which need adding", and the known weaknesses are in [docs/DESIGN.md](docs/DESIGN.md).

**What the contract cannot do.** It has no method that sends reward money. It votes only on a transfer it filed itself, for a payment a steward accepted. It cannot open more reward than the DAO's caps. It cannot serve a second DAO. Removing the role with one proposal takes away all its power.

## Try it: do X, see Y

**0. Open the quest from the video. Nothing to install.**

Open https://ashiklijo.github.io/grapevine/web/#quest/21

See: the vine Noor → Bea → Kofi → Rosa; three payments, 1 NEAR to Rosa and 0.5 to Kofi countersigned by Tomas, 0.25 to Bea paid at once inside her earned limit, each linked to its `Transfer` proposal on the DAO (open one to read it from the DAO itself); and the near.social posts of the chain, including the ones written by the contract. Records shows each person's points and the payment behind every point. The page reads testnet's RPC and FastData directly; there is no server behind it.

The steps below need Node 20 or later. Run `npm ci` once.

**1. Check what is on chain. No account needed.**

```bash
node scripts/verify.mjs
```

See: the DAO's policy has one role holding only the Grapevine contract, with three transfer permissions; the board's stewards are the DAO's own council; every paid payment matches an approved `Transfer` proposal on the DAO with the same payee and amount; every point on every record is a paid payment; the contract's own posts are on FastData with the contract as their author.

**2. Open the board.**

```bash
node scripts/serve.mjs
```

Open <http://127.0.0.1:4180>.

- `#board`: see the live quests, the treasury balance and the budget left, read from testnet in your browser.
- Open a finished quest: see the vine (who heard it from whom), each payment with its route, and the posts on FastData. Click **DAO proposal #…** on a payment to read that proposal from the DAO itself.
- `#records`: see each named account's record. Open one to see where every point came from.
- `#install`: see the exact two proposals that install Grapevine on a DAO.
- `#limits`: see what it cannot do and where it can be fooled.

**3. Put your own account on a quest's vine. Needs a testnet account, about two minutes.**

```bash
near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
```

```bash
node scripts/try.mjs <name>.testnet
```

See: a near.social post from your account on testnet's FastData that quotes the post you heard the quest from, a `pass_on` transaction, your path back to the sponsor, and what you would be paid. Reload the quest in the board and you are on the vine. Being paid needs a steward of the demo DAO to accept a claim, and those are demo accounts on the author's machine.

**4. Run the contract's rules.**

```bash
cd contract && cargo test -p grapevine-logic
```

See: 42 tests pass. Every decision about money (the split, the routes, the allowance, the budget, what counts as paid, how the DAO's policy and proposals are read) is a pure function in a crate with no NEAR runtime, so this needs only Rust.

```bash
cd contract && cargo test -p grapevine
```

See: 29 tests pass. These run the contract itself on near-sdk's mocked runtime, with the test playing the DAO: each call the contract makes to the DAO is read from the receipt it created (method, arguments, bond), and the DAO's answer is handed to the callback the way the runtime would. They cover who may open a board, storage billing, the split and its routes, countersigns, at-once payments and their allowance, decline and its refunds, the DAO's vote above the cap, rejected, removed, failed and expired proposals, late answers kept as orphans, barred accounts, the float, pause and resume. Breaking a rule in the contract on purpose makes the matching test fail. On Windows this needs the MSVC toolchain, because near-sdk's test runtime links C code.

```bash
node --test scripts/
```

See: 10 tests pass. They check, with no network, that what this project writes to near.social follows the `social-kv/1` standard key for key, and that the reader handles deleted posts, unfollows and bad references.

**5. Run the whole thing on a DAO you control. About 17 test NEAR, from two faucet accounts.**

See [docs/DEPLOY.md](docs/DEPLOY.md). `scripts/deploy.mjs` creates a Sputnik DAO on the unmodified factory, installs Grapevine through the DAO's own votes, and `scripts/e2e.mjs` then runs every path on live testnet: a paid chain, earned trust paying at once, a fake chain, a council vote, a pause, and the refusals.

**6. Let an agent scout.**

```bash
node scripts/scout.mjs <account>
```

See: for each open quest, the people that account follows on near.social whose profile or recent posts match it. With `--pass`, it passes the quest on and mentions the best match. The guide for agents is [web/skill.md](web/skill.md).

**7. Re-measure the problem. About ten minutes on free RPC.**

```bash
python scripts/census.py
```

See: `data/bounties-summary.json` with the numbers in the table above, moved by whatever has happened on chain since.

## What ran and what did not

<!-- status:start -->
| Piece | State | Evidence |
|---|---|---|
| Rules: split, routes, allowance, budget, payment states, policy and proposal parsing | Ran | `cargo test -p grapevine-logic`, 42 tests |
| The contract on near-sdk's mocked runtime: permissions, storage billing, calls to the DAO and every answer it can give | Ran | `cargo test -p grapevine`, 29 tests; three rules broken on purpose were each caught |
| near.social writer and reader against the standard | Ran | `node --test scripts/`, 10 tests |
| near.social reader against live mainnet data (profiles, follows, posts, suggestions) | Ran | by hand on 2026-11-11, against `kv.main.fastnear.com` |
| Contract builds to wasm | Ran | `cargo near build non-reproducible-wasm --no-abi`, 307 KB |
| Independent review of the contract, two passes | Ran, findings fixed | "Security review" below |
| Census of Sputnik bounties on mainnet | Ran | `data/bounties-summary.json` |
| Contract on testnet, installed on a real Sputnik DAO by the DAO's own votes | Ran | `node scripts/deploy.mjs` on 2026-11-14; accounts, proposals and votes in [docs/TESTNET.md](docs/TESTNET.md) |
| Every path on live testnet: paid chain, earned trust paying at once, fake chain, decline, caps, pause and resume, the DAO's own vote above the cap, and the refusals | Ran | `node scripts/e2e.mjs`: 102 of 102 checks on 2026-11-14. One timing check could not run because the RPC was slow; it says so, and the contract tests cover it. Results in [docs/TESTNET.md](docs/TESTNET.md) |
| Read-only proof of what is on chain: every paid payment matches an approved DAO proposal, every point is a paid payment | Ran | `node scripts/verify.mjs`, all checks passed |
| The contract's own near.social posts, indexed by FastData on testnet with the contract as author | Ran | checked by `scripts/e2e.mjs` and `scripts/verify.mjs` |
| Demo video, recorded from the real site in demo mode against the live testnet contract | Ran | [`demo/grapevine-demo.mp4`](demo/grapevine-demo.mp4), 1 min 37 s; quest #21 on the board is the one in the video |
<!-- status:end -->

## Contract

Called by the DAO, through a `FunctionCall` proposal: `create_board`, `update_board`, `set_barred`, `resume`, `withdraw_float`, `abandon_payout`. The DAO can also call `open_quest`, `accept` and `close_quest` itself.

Called by stewards: `open_quest`, `accept`, `countersign`, `decline`, `close_quest`, `pause`, `unstick`.

Called by anyone: `pass_on`, `claim`, `advance`, `reconcile`, `sync`.

Views: `dao`, `get_board`, `list_boards`, `get_quest`, `list_quests`, `list_links`, `get_link`, `list_claims`, `get_payout`, `list_payouts`, `preview`, `get_record`, `list_entries`, `list_people`, `totals`, `social_account`, `version`.

Every state change logs a NEP-297 event with `"standard": "grapevine"`.

The copy's own balance is its float, for proposal bonds and storage. It starts with the deposit on `create_board`, anyone can send it more, and the DAO can take the spare part back. The contract reads it from the account itself and keeps no counter of it. It is never reward money.

## Security review

Before anything was deployed, the contract was reviewed by a separate AI agent that was given the code and a threat model, and no account of the design. It was told to try to break it. This was not a human or professional audit.

It could not make the contract vote on a proposal it had not filed, overpay a quest, or skip the second steward on a first payment. It did find these, all fixed:

| Finding | Fix |
|---|---|
| **Critical.** The first version let many DAOs share one contract. A hostile "DAO" contract could lie about proposal bonds and drain the other boards' floats. | One copy serves one DAO, bound at creation. The float is no longer a counter: it is read from the account's balance. |
| Storage billing could be gamed to mint float | Removed with the counter. Storage is backed by the real balance, and outsiders pay for their own. |
| One steward could raise an accomplice's limit with small self-approved payments, then pay them the whole period's budget alone | The earned limit is now an allowance per budget period. One steward cannot pay an account past it, however many quests they accept. |
| A proposal that expired by a vote keeps its bond on the DAO, but was treated as returned | No bond accounting is left to get wrong. |
| A late answer from the DAO could be taken for a newer call's, leaving an untracked second proposal | Each call carries an attempt number. A late answer is ignored and logged as an orphan proposal. |
| A finalize that the DAO answered by paying was recorded as "expired" | Nothing is concluded after a finalize. The next read decides. |
| A barred account could still be paid through a retried vote | Barred is checked before every vote. |
| A removed proposal gave its budget back even if it had been paid first | A proposal that vanished never refunds the budget. |
| A council member re-running a failed transfer could make it read "Approved" for two blocks | A payment is not counted as paid until the newest action on its proposal is 12 blocks old. |
| A quest title could forge a field in the proposal text | Angle brackets, asterisks and invisible characters are stripped from all public text. |
| Any steward could close a quest the DAO opened by vote | Only the DAO can. |
| A payment whose proposal can never be read again had no exit | `abandon_payout`, callable only by the DAO. |

A second pass on the fixed code found no way for an outsider, a claimant or a single steward to take NEAR out of the contract. It found these, also fixed:

| Finding | Fix |
|---|---|
| Storage written by stewards was unbilled, so one steward could turn the float into storage | Whoever writes pays: `open_quest` and `accept` bill the caller, as `pass_on` and `claim` already did. The contract also holds back a reserve for each open payment, so a callback never fails for want of a few bytes. |
| An at-once payment left unfiled kept its allowance from an old period, so idle periods could be saved up | It has to be filed in the period it was allowed in. After that it needs a second steward. A decline gives allowance back only to the period it was taken from. |
| One tiny countersigned payment unlocked a full step of limit | The limit never exceeds the largest payment a second steward or the DAO's vote has approved for that account. |
| A payee barred between filing and voting made the callback fail and forget its proposal | Nothing on that callback can fail. A barred payee simply gets no vote. |
| A retried vote could land after the proposal's period and expire it, losing its bond | No retry vote in the last two minutes of the period. `reconcile` closes it instead. |
| A council of more than 40 made every later sync fail, leaving removed stewards cached | The board then has no stewards until the role is smaller, and everything else is still updated. |
| 32 long reasons for leaving links out could overflow the event log | The event names accounts only. Duplicates are refused. |

Known limits, accepted for now:

- Stewards are read from the DAO's policy when someone calls `sync`, not on every call. A removed council member keeps steward rights until the next `sync`. Anyone can call it.
- A declined payment is final. The DAO can still pay that person with an ordinary proposal.
- If a call to the DAO never reports back and a steward resets the payment, a second proposal can exist for it. Grapevine votes on one only. The other is stored on the payment as an orphan and logged, and the council should reject it: approving it would pay twice.
- A council member who votes on a proposal after its period has ended makes Sputnik keep that proposal's bond. That is Sputnik's rule, and the bond is small.
- The reward budget counts quests opened in a period. A payment for an older quest can still land in a later period.
- Any steward can pause the board, as often as they like. Only the DAO's vote resumes it.
- The contract account keeps its deploy key on testnet, so the code can be patched during the hackathon. A real deployment should delete that key.

## near.social

- **People post.** The sponsor's quest, each pass and each claim can carry a near.social post. A pass quotes the post it came from. The post's reference is stored next to the link on chain.
- **The contract posts.** On near.social the author of a post is the predecessor of a function call to the account `social`. So a contract can be an author. Grapevine posts each quest, split and confirmed payment from its own account, mentioning the people paid. No bot and no key are involved.
- **The follow graph says who to tell.** The app reads who you follow from FastData, matches their bios and recent posts against the quest, and suggests the few people who fit.

near.social's app and indexer run on mainnet. On testnet this project writes the same `social-kv/1` standard to the same account name and reads it back from FastNEAR's public testnet KV API. The same code path points at mainnet when `NEAR_NETWORK=mainnet`.

In an explorer, every receipt that carries a post shows as failed, and that is by design. On mainnet the account `social` has no contract (`CodeDoesNotExist`). On testnet there is no account `social` at all (`AccountDoesNotExist`). FastData indexes the call either way. Because the contract posts in a separate receipt, a quest, a split or a payment never depends on its post: the call that opens a quest succeeds, and only the post's own receipt fails. The scripts count those receipts as posts, not as failures.

## Repository

| Path | What |
|---|---|
| `index.html`, `.nojekyll` | GitHub Pages: the root page forwards to the board in `web/`, served as it is |
| `contract/src/lib.rs` | The contract: storage, permissions and promises |
| `contract/src/tests.rs` | The contract run on near-sdk's mocked runtime, with the test playing the DAO |
| `contract/logic/src/lib.rs` | Every decision about money, as pure functions, with tests |
| `web/` | The static site. Reads RPC and FastData directly. No backend. |
| `web/social.js` | A reader for near.social on FastData KV. Runs in the browser and in Node. |
| `web/skill.md` | The guide for AI agents |
| `scripts/serve.mjs` | Serves the site. `--demo` adds the demo community and a keeper. |
| `scripts/deploy.mjs` | Deploys the contract and installs it through real DAO votes |
| `scripts/seed.mjs` | Gives the demo community profiles, follows and one finished quest |
| `scripts/e2e.mjs` | Live checks against testnet |
| `scripts/verify.mjs` | Read-only proof of what is on chain |
| `scripts/try.mjs` | Puts your own account on a quest's vine |
| `scripts/scout.mjs` | Matches open quests to the people an account follows |
| `scripts/census.py` | The measurement |
| `demo/` | How the demo video was made |
| `docs/` | Design, deployment, testnet results, submission notes |

Build the contract, from `contract/`:

```bash
cargo near build non-reproducible-wasm --no-abi
```

or, without cargo-near:

```bash
cargo build --release --target wasm32-unknown-unknown -p grapevine
```

`contract/.cargo/config.toml` sets `--cfg near`, which this version of near-sdk needs for contract panics to carry their messages. On Windows, set `CARGO_TARGET_DIR` to a short path.

## Libraries and AI-written code

Written with Claude Code (Anthropic) during the hackathon window. Everything in this repository is new work.

Libraries: `near-sdk` 5.30 (contract), `near-api-js` 7.4 (scripts), `playwright-core` (recording the demo). The site has no dependencies. Narration in the demo video is an AI voice (Chatterbox, an open-source model).

## Licence

MIT. See [LICENSE](LICENSE).
