# Design

## The idea in one paragraph

A bounty on a board reaches the people who already read that board. Most of what a community needs is known by someone two or three introductions away. Grapevine pays for the introductions: when a quest is done, the treasury pays the doer and each person on the chain that carried the word to them, in halves. The split is the one MIT used to win DARPA's Network Challenge in 2009, when a team found ten weather balloons hidden across the United States in under nine hours by paying finders, the people who invited them, and the people who invited those ([Pickard et al., Science, 2011](https://www.science.org/doi/10.1126/science.1205869)).

## What exists in Sputnik DAO and Trezu, and what Grapevine adds

The track's prompt asks which approval flows already exist and which need adding. Read from `near-daos/sputnik-dao-contract` (`sputnikdao2/src/proposals.rs`, `policy.rs`) and the Trezu docs.

| Need | Already in Sputnik DAO | Already in Trezu | Added by Grapevine |
|---|---|---|---|
| Custody | The DAO account holds everything | The same DAO | Nothing. Grapevine has no method that sends reward money. |
| Paying someone | `Transfer` proposal, passed by a role's vote policy | Shown and voted on as a payment request | Files the `Transfer` itself, with the description in the form Trezu parses (`* Title: … <br>* Notes: …`) |
| Approval that depends on the amount | Not possible. A vote policy is set per proposal kind and per role, never per amount. | One threshold per kind of request | A route chosen per payment: auto, countersign, or the DAO's ordinary vote |
| Approval that depends on who is paid | Not possible | Not possible | The route depends on the payee's record on this board |
| A bounty | `AddBounty`, `bounty_claim`, `BountyDone`: one claimer at a time, a bond to claim, one payee, a full vote to pay | Not shown as its own flow | Quests: anyone can pass on or claim, no bond, the reward is split along a chain |
| Paying more than one account for one job | Not possible in one proposal | Bulk payment requests | One `Transfer` per share, each with its own route |
| Reputation | None | None | Records per named account, one entry per paid payment |
| A budget for small spends | None: every transfer is a vote | None | Quest cap and period cap, enforced on chain |
| Install | `ChangePolicyAddOrUpdateRole` | Shows and votes on it as a policy change | Nothing. The role is an ordinary Sputnik role. |
| Uninstall | `ChangePolicyRemoveRole` | Shows and votes on it as a policy change | Nothing |

How a contract's single vote passes a transfer: Sputnik's `proposal_status` checks each role the voter belongs to, with that role's own vote policy for the proposal kind. A role whose group is one account, with `threshold: [1, 1]` for `transfer`, is satisfied by that account's vote. The role is given only `transfer:AddProposal`, `transfer:VoteApprove` and `transfer:Finalize`.

## The rules

All of these are pure functions in [`contract/logic/src/lib.rs`](../contract/logic/src/lib.rs), with tests.

### The split

- The doer receives `doer_bps` of the reward (5000 on the demo board: half).
- The account that told the doer receives `relay_bps` (2500: a quarter). The account before that receives half as much, and so on for at most `max_hops` accounts (never more than 8).
- A share below `min_cut` is dropped, with every share after it.
- `doer_bps + 2 × relay_bps ≤ 10000` is enforced when a board is created. Since 1 + ½ + ¼ + … stays below 2, a split can never exceed the reward. What is left is never requested from the treasury.

### The route of each payment

Decided per payee when the claim is accepted:

| Condition | Route | Who approves |
|---|---|---|
| amount ≤ what is left of the payee's earned limit this period | Auto | Grapevine's vote, at once |
| otherwise, amount ≤ `countersign_cap` | Countersign | A second steward calls `countersign`, then Grapevine files and votes. Not the steward who accepted, not the payee. |
| amount > `countersign_cap` | Council | Grapevine files the transfer and never votes. The DAO votes as usual. |

Earned limit = `min(ceiling, step × points, vouched)`, where points are the payee's paid payments on this board and `vouched` is the largest single payment a second steward or the DAO's vote has approved for that account. So a tiny countersigned payment cannot unlock a large limit. A new account has a limit of zero, so its first payment always needs a second steward. The limit is an allowance for the whole budget period: each auto-routed payment is taken out of it when the claim is accepted, and given back if that payment is declined. So the most one steward can move to one account without a second steward is that account's limit per period, not per quest. An at-once payment has to be filed in the period it was allowed in; left longer, it needs a second steward, so idle periods cannot be saved up.

### The budget

A steward can open a quest of at most `quest_cap`, and all stewards together at most `period_cap` per period. Reward that a split leaves over, a declined payment, or a closed quest is given back to the period that reserved it. The DAO itself can open a quest of any size through a `FunctionCall` proposal.

### Who can do what

| Action | Who |
|---|---|
| `create_board` | Only the one DAO the copy was created for |
| `update_board`, `set_barred`, `resume`, `withdraw_float`, `abandon_payout` | The DAO only (`predecessor` is the DAO, so only a passed `FunctionCall` proposal) |
| `open_quest` | A steward, inside the caps. Or the DAO. |
| `pass_on`, `claim` | Anyone except the quest's sponsor. Each pays its own storage. |
| `accept` | The quest's sponsor, or the DAO. For a quest the DAO opened, any steward. Never someone on the chain being paid. |
| `close_quest` | The sponsor, a steward, or the DAO. For a quest the DAO opened, only the DAO. |
| `countersign` | A steward who is neither the accepter nor the payee |
| `decline` | A steward, before the payment is filed. Not the payee. |
| `advance`, `reconcile`, `sync` | Anyone |
| `pause` | Any steward. Only the DAO can `resume`. |

Stewards are not a list kept by Grapevine. `sync` reads the DAO's own policy and takes the members of the role the board names (for example `council`), along with the proposal bond and what the policy lets Grapevine do.

## A payment's life

```
Pending ──file──▶ Filing ──▶ Filed ──vote──▶ Voting ──▶ Voted ──20 s, re-read──▶ Paid
   │                           │                                                   ▲
   └─decline──▶ Declined       └─(Council route: the DAO votes)──▶ Clearing ───────┘
                    ▲                          │
                    └── rejected, removed or expired on the DAO
```

- **Storage.** Whoever writes pays for the bytes: `pass_on`, `claim`, `open_quest` and `accept` bill the caller and return the change. What the callbacks write later is covered by a reserve the contract holds back for each open payment, on top of a fixed cushion.
- **File** attaches the DAO's proposal bond from the copy's own balance. The bond returns when the proposal is approved, rejected or finalized after expiry. There is no counter to keep in step with it: the float is whatever the account holds beyond what its storage locks.
- **Approved is not Paid.** Sputnik marks a proposal Approved before the transfer has run, and flips it to Failed if the transfer then fails. Grapevine counts a payment as paid only when it reads Approved at least 20 seconds after the vote, in a later transaction, and the newest action in the proposal's own log is at least 12 blocks old. If it reads Failed, it asks the DAO to finalize (re-run) the transfer and starts the wait again.
- **A failed read changes nothing.** `reconcile` reads with `get_proposals(from_index, 1)`. A proposal that was removed gives an empty list, which is positive proof. A call that fails (for example, starved of gas by its caller) is not.
- **Grapevine only votes on what it filed.** The proposal id comes from the `add_proposal` callback, and `reconcile` also checks that the proposal's proposer, receiver and amount are the payment's.

## near.social

near.social stores everything as key-value writes to the account `social` ([the `social-kv/1` standard](https://api2.near.social/standard.md)), indexed by FastData. The author of a write is the receipt's predecessor. Grapevine uses that in three ways.

1. **People post.** A sponsor's quest, each pass and each claim can carry a near.social post. A pass quotes the post it came from, so the chain is also a public thread. The post's reference (`account/post_id`) is stored next to the link on chain.
2. **The contract posts.** Because the author is the predecessor, a contract can be an author. When a quest opens, a claim is accepted, or a payment clears, the contract calls `social.__fastdata_kv` itself. The receipt fails by design (there is no contract at `social`) and FastData indexes it anyway. There is no bot and no key: a payment post exists only because the payment was confirmed on chain. Posts mention the payees, which is what notifies them on near.social.
3. **The follow graph says who to tell.** The app reads who you follow and who follows you from FastData, and matches their bios and recent posts against the quest. It suggests the few people who fit. It also pre-fills "who told you" with someone you follow who is already on the vine.

On testnet, the app writes the same standard to the same account name and reads it back from FastNEAR's public testnet KV API. near.social's own app and indexer are mainnet-only.

## What can go wrong, and what was done about it

| Risk | Answer |
|---|---|
| The doer adds accounts of their own to the chain, to collect relay shares | Those accounts have no record, so their shares are never auto-paid. The accepting steward can leave them out with a public reason, which also restores the shares of honest relays above them. A countersigning steward can decline. |
| A steward leaves out an honest newcomer | Only accounts with no record can be left out. The reason and the steward's name are stored on the quest and shown on the board. The money stays in the treasury, so the steward gains nothing. |
| The doer skips the people who told them and claims from the sponsor's post | Not preventable by any contract: the quest is public. The doer's own share is the same either way, so there is no profit without also controlling an account with a record. |
| One steward pays a friend | A first payment needs a second steward. After that, auto-paid amounts are capped by the earned limit, the quest cap and the period cap. |
| Two stewards pay each other | The accepter cannot countersign, and neither can the payee. With a two-person council that leaves nobody, so the payment has to go to the DAO's vote. |
| A bug in Grapevine | The role is limited to transfers. Stewards can open at most `period_cap` per period. Any steward can pause. One proposal removes the role. |
| Another DAO sharing the contract's balance | Not possible. One copy serves one DAO, named when it is created. The first version shared one contract between DAOs, and an independent review showed that a hostile "DAO" contract could lie about bonds and drain the others' floats. |
| One steward and an accomplice with a record | The earned limit is an allowance per period. The most they can take is that account's limit, each period, until a second steward or the council notices. |
| Spam on near.social | A pass earns nothing unless someone on that branch gets the quest done, so blasting is pointless. The app suggests specific people instead. |

## Prior art

- The DARPA Network Challenge and MIT's recursive incentive: Pickard et al., "Time-Critical Social Mobilization", Science 334 (2011).
- Query incentive networks: Kleinberg and Raghavan, FOCS 2005.
- The Sybil problem in referral trees: Babaioff, Dobzinski, Oren and Zohar, "On Bitcoin and Red Balloons", EC 2012; Drucker and Fleischer, "Simpler Sybil-Proof Mechanisms for Multi-Level Marketing", EC 2012. No split is both proof against fake links and proof against skipping honest ones. Grapevine keeps MIT's split, because it rewards the last introduction most, and answers fake links with records and a second pair of eyes.
- A contract as the only member of a Sputnik role, with permissions for one proposal kind, is a known pattern. The code here was written for this project.
