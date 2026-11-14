//! The contract itself, run against near-sdk's mocked runtime: storage, permissions, the calls
//! it makes to the DAO, and what it does with the DAO's answers.
//!
//! The DAO is played by the test. A call to it is checked by reading the receipt the contract
//! created, and its answer is handed to the callback the way the runtime would.
//!
//!     cargo test -p grapevine
//!
//! On Windows this needs the MSVC toolchain, because near-sdk's test harness links C code.

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

use super::*;

const ME: &str = "grapevine.testnet";
const DAO: &str = "coop.sputnikv2.testnet";
const NOOR: &str = "noor.testnet";
const TOMAS: &str = "tomas.testnet";
const KEEPER: &str = "keeper.testnet";
const X: &str = "xena.testnet";
const Y: &str = "yusuf.testnet";
const Z: &str = "zoe.testnet";
const MAL: &str = "mallory.testnet";
const SOCK: &str = "sock.testnet";

const N: u128 = logic::YOCTO;
const SEC: u64 = 1_000_000_000;
const DAY: u64 = 86_400 * SEC;
const BOND: u128 = N / 100;
const STORAGE_AT_START: u64 = 307_200;

fn acct(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn config() -> BoardConfig {
    BoardConfig {
        steward_role: "council".to_string(),
        doer_bps: 5_000,
        relay_bps: 2_500,
        max_hops: 5,
        min_cut: U128(N / 100),
        step: U128(N / 4),
        ceiling: U128(3 * N / 4),
        countersign_cap: U128(N),
        quest_cap: U128(2 * N),
        period_cap: U128(12 * N),
        period_ns: U64(7 * DAY),
        announce: true,
        site: String::new(),
    }
}

fn policy(council: &[&str]) -> Value {
    json!({
        "roles": [
            {"name": "council", "kind": {"Group": council}, "permissions": ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"], "vote_policy": {}},
            {"name": "all", "kind": "Everyone", "permissions": ["transfer:AddProposal"], "vote_policy": {}},
            {"name": "grapevine", "kind": {"Group": [ME]}, "permissions": ["transfer:AddProposal", "transfer:VoteApprove", "transfer:Finalize"],
             "vote_policy": {"transfer": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 1]}}},
        ],
        "default_vote_policy": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2]},
        "proposal_bond": BOND.to_string(),
        "proposal_period": (7 * DAY).to_string(),
        "bounty_bond": BOND.to_string(),
        "bounty_forgiveness_period": DAY.to_string(),
    })
}

/// The function calls the contract made in the current call: receiver, method, arguments, deposit.
fn calls() -> Vec<(String, String, Value, u128)> {
    let mut out = Vec::new();
    for receipt in get_created_receipts() {
        for action in receipt.actions {
            if let MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } = action {
                out.push((
                    receipt.receiver_id.to_string(),
                    String::from_utf8(method_name).unwrap(),
                    serde_json::from_slice(&args).unwrap_or(Value::Null),
                    attached_deposit.as_yoctonear(),
                ));
            }
        }
    }
    out
}

/// The plain transfers the contract made in the current call: receiver and amount.
fn transfers() -> Vec<(String, u128)> {
    let mut out = Vec::new();
    for receipt in get_created_receipts() {
        for action in receipt.actions {
            if let MockAction::Transfer { deposit, .. } = action {
                out.push((receipt.receiver_id.to_string(), deposit.as_yoctonear()));
            }
        }
    }
    out
}

fn posts() -> Vec<String> {
    calls()
        .into_iter()
        .filter(|(to, method, _, _)| to == "social" && method == "__fastdata_kv")
        .filter_map(|(_, _, args, _)| args.as_object().and_then(|o| o.values().next().cloned()))
        .filter_map(|v| v.get("text").and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// The call must be refused with this error.
fn refused<R>(code: &str, f: impl FnOnce() -> R) {
    let Err(err) = catch_unwind(AssertUnwindSafe(f)) else {
        panic!("expected {code}, but the call went through");
    };
    let message = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(message.contains(code), "expected {code}, got: {message}");
}

/// The contract, the clock and the account's balance, carried from one call to the next.
///
/// One per test: the mocked runtime keeps its storage per thread, and each test has its own thread.
struct World {
    c: Grapevine,
    now: u64,
    height: u64,
    storage: u64,
    balance: u128,
    /// Block height of the last vote, as the DAO would show it in a proposal's action log.
    acted_at: u64,
}

impl World {
    /// A deployed copy with its board opened by the DAO and its council read from the DAO's policy.
    fn new() -> Self {
        let mut w = World {
            c: {
                testing_env!(VMContextBuilder::new().current_account_id(acct(ME)).predecessor_account_id(acct(ME)).build());
                Grapevine::new(acct(DAO), None)
            },
            now: 1_794_000_000 * SEC,
            height: 1_000,
            storage: STORAGE_AT_START,
            balance: byte_cost_of(STORAGE_AT_START),
            acted_at: 0,
        };
        w.enter(DAO, 3 * N / 10);
        drop(w.c.create_board(config()));
        assert!(calls().iter().any(|(to, method, _, _)| to == DAO && method == "get_policy"), "opening a board reads the DAO's policy");
        w.leave();
        w.sync(&[NOOR, TOMAS]);
        w
    }

    fn enter(&self, who: &str, deposit: u128) {
        testing_env!(self.context(who, deposit));
    }

    /// Enter a callback, with the answers of the calls it follows.
    fn enter_callback(&self, results: Vec<PromiseResult>) {
        testing_env!(self.context(ME, 0), near_sdk::test_vm_config(), RuntimeFeesConfig::test(), HashMap::default(), results);
    }

    fn context(&self, who: &str, deposit: u128) -> near_sdk::VMContext {
        VMContextBuilder::new()
            .current_account_id(acct(ME))
            .predecessor_account_id(acct(who))
            .signer_account_id(acct(who))
            .block_timestamp(self.now)
            .block_height(self.height)
            .account_balance(NearToken::from_yoctonear(self.balance))
            .storage_usage(self.storage)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .prepaid_gas(Gas::from_tgas(300))
            .build()
    }

    /// Carry the storage and the balance the call left behind into the next call.
    fn leave(&mut self) {
        self.storage = env::storage_usage();
        self.balance = env::account_balance().as_yoctonear();
    }

    fn tick(&mut self, seconds: u64) {
        self.now += seconds * SEC;
        self.height += seconds;
    }

    fn sync(&mut self, council: &[&str]) {
        self.enter_callback(vec![]);
        self.c.on_synced(acct(DAO), Ok(policy(council)));
        self.leave();
    }

    fn open(&mut self, who: &str, reward: u128) -> u64 {
        self.enter(who, N / 20);
        let id = self.c.open_quest(acct(DAO), "Find a sign-language interpreter".to_string(), "Saturday, 10 to 12.".to_string(), U128(reward), U64(self.now + 5 * DAY), None);
        self.leave();
        id.0
    }

    fn pass(&mut self, who: &str, quest: u64, via: Option<&str>) {
        self.enter(who, N / 100);
        self.c.pass_on(U64(quest), via.map(acct), None);
        self.leave();
    }

    fn claim(&mut self, who: &str, quest: u64, via: Option<&str>) {
        self.enter(who, N / 100);
        self.c.claim(U64(quest), via.map(acct), "I can do this.".to_string(), None);
        self.leave();
    }

    fn accept(&mut self, who: &str, quest: u64, doer: &str, leave_out: &[&str]) -> Vec<u64> {
        self.enter(who, N / 10);
        let left: Vec<LeftOut> = leave_out.iter().map(|a| LeftOut { account: acct(a), reason: "No history with us".to_string() }).collect();
        let ids = self.c.accept(U64(quest), acct(doer), left);
        self.leave();
        ids.into_iter().map(|id| id.0).collect()
    }

    /// Anyone pushes a payment: the contract files it. Then the DAO answers with a proposal id.
    /// Returns whether the contract went on to vote.
    fn file(&mut self, id: u64, proposal: u64) -> bool {
        self.enter(KEEPER, 0);
        let step = self.c.advance(U64(id));
        assert!(matches!(step, PromiseOrValue::Promise(_)), "advance should have called the DAO");
        drop(step);
        self.check_filing(id);
        self.leave();
        self.dao_filed(id, proposal)
    }

    fn countersign(&mut self, who: &str, id: u64, proposal: u64) -> bool {
        self.enter(who, 0);
        drop(self.c.countersign(U64(id)));
        self.check_filing(id);
        self.leave();
        self.dao_filed(id, proposal)
    }

    /// The call just made must be an `add_proposal` for exactly this payment, carrying the bond.
    fn check_filing(&self, id: u64) {
        let payout = self.payout(id);
        let filed: Vec<_> = calls().into_iter().filter(|(to, method, _, _)| to == DAO && method == "add_proposal").collect();
        assert_eq!(filed.len(), 1, "one proposal per call");
        let (_, _, args, deposit) = &filed[0];
        assert_eq!(*deposit, BOND, "the bond rides on the proposal");
        let transfer = &args["proposal"]["kind"]["Transfer"];
        assert_eq!(transfer["receiver_id"], json!(payout.payee));
        assert_eq!(transfer["amount"], json!(payout.amount));
        assert_eq!(transfer["token_id"], json!(""));
        let text = args["proposal"]["description"].as_str().unwrap();
        assert!(text.starts_with("* Title: Grapevine quest #") && text.contains(" <br>* Notes: "), "Trezu's format: {text}");
    }

    /// The DAO's answer to `add_proposal`, and to the vote if the contract casts one.
    fn dao_filed(&mut self, id: u64, proposal: u64) -> bool {
        let attempt = self.payout(id).attempt;
        self.enter_callback(vec![PromiseResult::Successful(proposal.to_string().into_bytes())]);
        let next = self.c.on_filed(U64(id), attempt, Ok(json!(proposal)));
        let votes = matches!(next, PromiseOrValue::Promise(_));
        drop(next);
        if votes {
            let vote: Vec<_> = calls().into_iter().filter(|(to, method, _, _)| to == DAO && method == "act_proposal").collect();
            assert_eq!(vote.len(), 1);
            assert_eq!(vote[0].2["id"], json!(proposal), "it votes on the proposal it has just filed, and no other");
            assert_eq!(vote[0].2["action"], json!("VoteApprove"));
            assert_eq!(vote[0].2["proposal"]["Transfer"]["receiver_id"], json!(self.payout(id).payee));
        } else {
            assert!(!calls().iter().any(|(_, method, _, _)| method == "act_proposal"), "no vote was due");
        }
        self.leave();
        if votes {
            self.dao_voted(id, true);
        }
        votes
    }

    fn dao_voted(&mut self, id: u64, ok: bool) -> bool {
        let attempt = self.payout(id).attempt;
        self.acted_at = self.height;
        self.enter_callback(vec![if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed }]);
        let voted = self.c.on_voted(U64(id), attempt);
        self.leave();
        voted
    }

    /// What the DAO would answer to `get_proposals` for this payment's proposal.
    fn proposal(&self, id: u64, status: &str) -> Value {
        let p = self.payout(id);
        json!([{
            "id": p.proposal_id.unwrap().0,
            "proposer": ME,
            "description": "x",
            "kind": {"Transfer": {"token_id": "", "receiver_id": p.payee, "amount": p.amount, "msg": null}},
            "status": status,
            "vote_counts": {},
            "votes": {},
            "submission_time": p.filed_at,
            "last_actions_log": [{"block_height": self.acted_at.to_string()}],
        }])
    }

    /// The contract reads the proposal and is shown this status.
    fn see(&mut self, id: u64, status: &str) {
        let page = self.proposal(id, status);
        self.show(id, Ok(page));
    }

    fn show(&mut self, id: u64, page: Result<Value, PromiseError>) {
        self.enter_callback(vec![]);
        drop(self.c.on_checked(U64(id), page));
        self.leave();
    }

    /// The transfer ran: the DAO returned the bond, and a later look confirms the payment.
    fn settle(&mut self, id: u64) {
        self.balance += BOND;
        self.tick(30);
        self.see(id, "Approved");
        assert_eq!(self.payout(id).phase, PayPhase::Paid);
    }

    fn payout(&self, id: u64) -> Payout {
        self.c.get_payout(U64(id)).unwrap()
    }
    fn quest(&self, id: u64) -> Quest {
        self.c.get_quest(U64(id)).unwrap()
    }
    fn board(&self) -> Board {
        self.enter(KEEPER, 0);
        self.c.get_board(acct(DAO)).unwrap()
    }
    fn record(&self, who: &str) -> RecordView {
        self.enter(KEEPER, 0);
        self.c.get_record(acct(DAO), acct(who))
    }
    fn plan(&self, quest: u64, doer: &str, leave_out: &[&str]) -> Plan {
        self.enter(KEEPER, 0);
        self.c.preview(U64(quest), acct(doer), leave_out.iter().map(|a| acct(a)).collect())
    }

    /// A quest that travelled sponsor -> Z -> Y -> X, claimed by X and accepted by Noor.
    /// Returns the quest and its three payments: X's, Y's and Z's.
    fn chain_quest(&mut self, reward: u128) -> (u64, Vec<u64>) {
        let quest = self.open(NOOR, reward);
        self.pass(Z, quest, None);
        self.pass(Y, quest, Some(Z));
        self.claim(X, quest, Some(Y));
        let ids = self.accept(NOOR, quest, X, &[]);
        (quest, ids)
    }

    /// Pay everything on a quest through a second steward, giving everyone on it a record.
    fn pay_all_countersigned(&mut self, ids: &[u64], first_proposal: u64) {
        for (i, id) in ids.iter().enumerate() {
            assert!(self.countersign(TOMAS, *id, first_proposal + i as u64));
            self.settle(*id);
        }
    }
}

fn byte_cost_of(bytes: u64) -> u128 {
    u128::from(bytes) * 10_000_000_000_000_000_000
}

// ---- Who may open a board ----

#[test]
fn only_the_dao_a_copy_was_made_for_can_open_its_board() {
    let mut w = World::new();
    assert_eq!(w.c.dao(), acct(DAO));
    assert_eq!(w.c.list_boards(), vec![acct(DAO)]);
    w.enter(MAL, N);
    refused("ERR_NOT_THIS_DAO", || w.c.create_board(config()));
    w.enter(DAO, N);
    refused("ERR_BOARD_EXISTS", || w.c.create_board(config()));
}

#[test]
fn the_council_the_bond_and_the_permissions_come_from_the_daos_policy() {
    let mut w = World::new();
    let board = w.board();
    assert_eq!(board.stewards, vec![acct(NOOR), acct(TOMAS)]);
    assert_eq!(board.bond.0, BOND);
    assert_eq!(board.proposal_period_ns.0, 7 * DAY);
    assert!(board.can_file && board.can_approve && board.can_finalize);

    // The council changes on the DAO. Anyone can have the board read it again.
    w.enter(MAL, 0);
    drop(w.c.sync(acct(DAO)));
    w.leave();
    w.sync(&[TOMAS, X]);
    assert_eq!(w.board().stewards, vec![acct(TOMAS), acct(X)]);

    // A read that fails, or is not a policy, changes nothing.
    w.enter_callback(vec![]);
    assert!(!w.c.on_synced(acct(DAO), Err(PromiseError::Failed)));
    assert!(!w.c.on_synced(acct(DAO), Ok(json!({"roles": "nonsense"}))));
    assert_eq!(w.board().stewards, vec![acct(TOMAS), acct(X)]);
}

#[test]
fn a_council_too_large_to_keep_leaves_the_board_with_no_stewards() {
    let mut w = World::new();
    let many: Vec<String> = (0..41).map(|i| format!("member{i}.testnet")).collect();
    let refs: Vec<&str> = many.iter().map(String::as_str).collect();
    w.sync(&refs);
    let board = w.board();
    assert!(board.stewards.is_empty(), "nobody from the older read stays on");
    assert_eq!(board.bond.0, BOND, "the rest is still read");
    w.enter(NOOR, N / 20);
    refused("ERR_NOT_A_STEWARD", || w.c.open_quest(acct(DAO), "t".into(), "b".into(), U128(N), U64(w.now + DAY), None));
}

#[test]
fn a_board_whose_role_is_missing_opens_no_quests() {
    let mut w = World::new();
    let mut bare = policy(&[NOOR, TOMAS]);
    bare["roles"].as_array_mut().unwrap().pop();
    w.enter_callback(vec![]);
    assert!(w.c.on_synced(acct(DAO), Ok(bare)));
    w.leave();
    assert!(!w.board().can_approve);
    w.enter(NOOR, N / 20);
    refused("ERR_NOT_INSTALLED", || w.c.open_quest(acct(DAO), "t".into(), "b".into(), U128(N), U64(w.now + DAY), None));
}

// ---- Quests and the vine ----

#[test]
fn opening_a_quest_reserves_budget_bills_the_opener_and_posts() {
    let mut w = World::new();
    let before = w.balance;
    w.enter(NOOR, N / 20);
    let id = w.c.open_quest(acct(DAO), "  Find an <b>interpreter</b>\n* Notes: pay me ".into(), "Saturday.".into(), U128(2 * N), U64(w.now + DAY), None);
    let said = posts();
    let back = transfers();
    w.leave();
    assert_eq!(id.0, 1);
    let quest = w.quest(1);
    assert_eq!(quest.title, "Find an binterpreter/b  Notes: pay me", "text that could forge a proposal field is stripped");
    assert_eq!(quest.sponsor, acct(NOOR));
    assert_eq!(quest.post, Some(format!("{ME}/{}", w.now / 1_000_000)), "the contract's own post, by its own account");
    assert_eq!(w.board().committed.0, 2 * N);
    assert_eq!(said.len(), 1);
    assert!(said[0].contains(&format!("@{DAO}")) && said[0].contains("Reward: 2 NEAR") && said[0].contains("#grapevine"), "{}", said[0]);
    // The opener paid for the bytes and got the rest of the deposit back.
    assert_eq!(back.len(), 1);
    assert_eq!(back[0].0, NOOR);
    let cost = N / 20 - back[0].1;
    assert!(cost > 0 && cost < N / 50, "storage cost {cost}");
    assert_eq!(w.balance - before, cost, "exactly the cost of the new bytes stayed behind");
}

#[test]
fn caps_and_bad_quests_are_refused() {
    let mut w = World::new();
    let soon = U64(w.now + DAY);
    w.enter(MAL, N / 20);
    refused("ERR_NOT_A_STEWARD", || w.c.open_quest(acct(DAO), "t".into(), "b".into(), U128(N), soon, None));
    w.enter(NOOR, N / 20);
    refused("ERR_OVER_QUEST_CAP", || w.c.open_quest(acct(DAO), "t".into(), "b".into(), U128(2 * N + 1), soon, None));
    refused("ERR_REWARD_TOO_SMALL", || w.c.open_quest(acct(DAO), "t".into(), "b".into(), U128(N / 1000), soon, None));
    refused("ERR_DEADLINE", || w.c.open_quest(acct(DAO), "t".into(), "b".into(), U128(N), U64(w.now), None));
    refused("ERR_DEADLINE", || w.c.open_quest(acct(DAO), "t".into(), "b".into(), U128(N), U64(w.now + 200 * DAY), None));
    refused("ERR_TITLE", || w.c.open_quest(acct(DAO), "   ".into(), "b".into(), U128(N), soon, None));
    refused("ERR_TITLE", || w.c.open_quest(acct(DAO), "x".repeat(101), "b".into(), U128(N), soon, None));
    refused("ERR_POST_REF", || w.c.open_quest(acct(DAO), "t".into(), "b".into(), U128(N), soon, Some("not a post".into())));

    // Six quests of 2 NEAR fill the period's 12 NEAR. A seventh has to wait for the next period.
    for _ in 0..6 {
        w.open(NOOR, 2 * N);
    }
    w.enter(TOMAS, N / 20);
    refused("ERR_OVER_PERIOD_CAP", || w.c.open_quest(acct(DAO), "t".into(), "b".into(), U128(N), U64(w.now + DAY), None));
    w.tick(7 * 86_400);
    assert_eq!(w.open(TOMAS, 2 * N), 7);
    assert_eq!(w.board().committed.0, 2 * N, "a new period starts clean");
    // The DAO itself is not held to the steward caps.
    w.enter(DAO, N / 20);
    let big = w.c.open_quest(acct(DAO), "A big one".into(), "b".into(), U128(50 * N), U64(w.now + DAY), None);
    w.leave();
    assert!(w.quest(big.0).by_dao);
}

#[test]
fn a_pass_records_who_you_heard_it_from_and_the_first_answer_stands() {
    let mut w = World::new();
    let quest = w.open(NOOR, 2 * N);
    w.pass(Z, quest, None);
    w.pass(Y, quest, Some(Z));
    // Hearing it from the sponsor is hearing it from nobody in between.
    w.pass(X, quest, Some(NOOR));
    assert_eq!(w.c.get_link(U64(quest), acct(Y)).unwrap().via, Some(acct(Z)));
    assert_eq!(w.c.get_link(U64(quest), acct(Y)).unwrap().depth, 2);
    assert_eq!(w.c.get_link(U64(quest), acct(X)).unwrap().via, None);
    assert_eq!(w.quest(quest).links, 3);
    assert_eq!(w.c.list_links(U64(quest), 0, 10).iter().map(|l| l.account.to_string()).collect::<Vec<_>>(), vec![Z, Y, X]);

    w.enter(Y, N / 100);
    refused("ERR_ALREADY_ON_THE_VINE", || w.c.pass_on(U64(quest), None, None));
    w.enter(MAL, N / 100);
    refused("ERR_SELF_REFERRAL", || w.c.pass_on(U64(quest), Some(acct(MAL)), None));
    refused("ERR_UNKNOWN_REFERRER", || w.c.pass_on(U64(quest), Some(acct(SOCK)), None));
    refused("ERR_POST_REF", || w.c.pass_on(U64(quest), None, Some("mallory.testnet/abc".into())));
    refused("ERR_NO_QUEST", || w.c.pass_on(U64(99), None, None));
    w.enter(NOOR, N / 100);
    refused("ERR_SPONSOR_CANNOT_JOIN", || w.c.pass_on(U64(quest), None, None));
    w.enter(DAO, N / 100);
    refused("ERR_SPONSOR_CANNOT_JOIN", || w.c.pass_on(U64(quest), None, None));

    // After the deadline the vine takes nobody new.
    w.tick(6 * 86_400);
    w.enter(MAL, N / 100);
    refused("ERR_QUEST_OVER", || w.c.pass_on(U64(quest), None, None));
    refused("ERR_QUEST_OVER", || w.c.claim(U64(quest), None, "late".into(), None));
}

#[test]
fn passing_on_and_claiming_cost_the_caller_their_own_storage() {
    let mut w = World::new();
    let quest = w.open(NOOR, 2 * N);
    let before = w.balance;
    w.enter(Z, N / 100);
    w.c.pass_on(U64(quest), None, Some(format!("{Z}/1794000000000")));
    let back = transfers();
    w.leave();
    let cost = N / 100 - back[0].1;
    assert_eq!(back[0].0, Z);
    assert!(cost > 0 && cost < N / 200, "a pass costs a few thousandths of a NEAR: {cost}");
    assert_eq!(w.balance - before, cost);

    w.claim(Z, quest, None);
    w.enter(Z, N / 100);
    refused("ERR_ALREADY_CLAIMED", || w.c.claim(U64(quest), None, "again".into(), None));
    w.enter(X, N / 100);
    refused("ERR_NOTE", || w.c.claim(U64(quest), None, " ".into(), None));
    // Last, because the mocked runtime keeps what a failed call wrote: no deposit, no pass.
    w.enter(Y, 0);
    refused("ERR_ATTACH_STORAGE_DEPOSIT", || w.c.pass_on(U64(quest), None, None));
}

// ---- Accepting a claim ----

#[test]
fn the_reward_splits_in_halves_up_the_chain_and_newcomers_need_a_second_steward() {
    let mut w = World::new();
    let quest = w.open(NOOR, 2 * N);
    w.pass(Z, quest, None);
    w.pass(Y, quest, Some(Z));
    w.claim(X, quest, Some(Y));

    let plan = w.plan(quest, X, &[]);
    let shares: Vec<(String, u128, PayRoute)> = plan.shares.iter().map(|s| (s.account.to_string(), s.amount.0, s.route)).collect();
    assert_eq!(
        shares,
        vec![
            (X.to_string(), N, PayRoute::Countersign),
            (Y.to_string(), N / 2, PayRoute::Countersign),
            (Z.to_string(), N / 4, PayRoute::Countersign),
        ]
    );
    assert_eq!(plan.unspent.0, N / 4);
    assert_eq!(plan.chain, vec![acct(Y), acct(Z)]);

    w.enter(TOMAS, N / 10);
    refused("ERR_NOT_THE_SPONSOR", || w.c.accept(U64(quest), acct(X), vec![]));
    w.enter(MAL, N / 10);
    refused("ERR_NOT_A_STEWARD", || w.c.accept(U64(quest), acct(X), vec![]));
    w.enter(NOOR, N / 10);
    refused("ERR_NO_CLAIM", || w.c.accept(U64(quest), acct(Z), vec![]));
    refused("ERR_LEFT_OUT_NOT_ON_THE_CHAIN", || w.c.accept(U64(quest), acct(X), vec![LeftOut { account: acct(MAL), reason: "x".into() }]));

    w.enter(NOOR, N / 10);
    let ids = w.c.accept(U64(quest), acct(X), vec![]);
    let said = posts();
    w.leave();
    assert_eq!(ids.len(), 3);
    assert!(said[0].contains(&format!("@{X} 1 NEAR")) && said[0].contains(&format!("@{Z} 0.25 NEAR")), "{}", said[0]);
    let quest_now = w.quest(quest);
    assert_eq!(quest_now.status, QuestStatus::Settling);
    assert_eq!(quest_now.doer, Some(acct(X)));
    assert_eq!(quest_now.open_payouts, 3);
    assert_eq!(w.board().committed.0, 2 * N - N / 4, "what the split left over went back to the budget");
    w.enter(NOOR, N / 10);
    refused("ERR_QUEST_NOT_OPEN", || w.c.accept(U64(quest), acct(X), vec![]));
}

#[test]
fn a_first_payment_cannot_be_pushed_by_one_person() {
    let mut w = World::new();
    let (_, ids) = w.chain_quest(2 * N);
    let x = ids[0];
    w.enter(KEEPER, 0);
    refused("ERR_NEEDS_COUNTERSIGN", || w.c.advance(U64(x)));
    w.enter(NOOR, 0);
    refused("ERR_SAME_STEWARD", || w.c.countersign(U64(x)));
    w.enter(MAL, 0);
    refused("ERR_NOT_A_STEWARD", || w.c.countersign(U64(x)));
    w.enter(X, 0);
    refused("ERR_NOT_A_STEWARD", || w.c.countersign(U64(x)));
    assert_eq!(w.payout(x).phase, PayPhase::Pending);
}

#[test]
fn a_countersigned_payment_is_filed_voted_and_only_then_counted_as_paid() {
    let mut w = World::new();
    let (quest, ids) = w.chain_quest(2 * N);
    let balance_before = w.balance;

    assert!(w.countersign(TOMAS, ids[0], 7), "the contract votes once a second steward has signed");
    let p = w.payout(ids[0]);
    assert_eq!((p.phase, p.proposal_id, p.countersigned_by.clone()), (PayPhase::Voted, Some(U64(7)), Some(acct(TOMAS))));
    assert_eq!(balance_before - w.balance, BOND, "the bond rode out on the proposal, and nothing else left");
    w.enter(TOMAS, 0);
    refused("ERR_NOT_WAITING_FOR_A_COUNTERSIGN", || w.c.countersign(U64(ids[0])));

    // Approved at once on the DAO, but the transfer is a later receipt. Too soon to count.
    w.tick(5);
    w.see(ids[0], "Approved");
    assert_eq!(w.payout(ids[0]).phase, PayPhase::Voted);
    // Twenty seconds on, but the newest action on the proposal is still fresh in blocks.
    w.now += 30 * SEC;
    w.height += 3;
    w.see(ids[0], "Approved");
    assert_eq!(w.payout(ids[0]).phase, PayPhase::Voted, "not paid until the last action has had its blocks");

    w.balance += BOND;
    w.tick(30);
    w.enter_callback(vec![]);
    let page = w.proposal(ids[0], "Approved");
    drop(w.c.on_checked(U64(ids[0]), Ok(page)));
    let said = posts();
    w.leave();
    assert_eq!(w.payout(ids[0]).phase, PayPhase::Paid);
    assert!(said[0].starts_with(&format!("@{X} was paid 1 NEAR for getting quest #{quest} done. Proposal #7")), "{}", said[0]);

    let record = w.record(X);
    assert_eq!((record.done, record.carried, record.points, record.earned.0), (1, 0, 1, N));
    assert_eq!(record.vouched.0, N, "a second steward approved 1 NEAR for this account");
    assert_eq!(record.limit.0, N / 4, "one point is one step");
    let entries = w.c.list_entries(acct(DAO), acct(X), 0, 10);
    assert_eq!(entries.len(), 1);
    assert_eq!((entries[0].quest_id.0, entries[0].proposal_id.0, entries[0].amount.0), (quest, 7, N));

    // The quest is done only when every payment is settled one way or the other.
    assert_eq!(w.quest(quest).status, QuestStatus::Settling);
    assert!(w.countersign(TOMAS, ids[1], 8));
    w.settle(ids[1]);
    w.enter(TOMAS, 0);
    w.c.decline(U64(ids[2]), "Not who told them".into());
    w.leave();
    let done = w.quest(quest);
    assert_eq!((done.status, done.paid.0, done.open_payouts), (QuestStatus::Done, N + N / 2, 0));
    assert_eq!(w.board().paid.0, N + N / 2);
    assert_eq!(w.c.totals().paid.0, N + N / 2);
    assert_eq!(w.c.list_people(acct(DAO), 0, 10).len(), 2);
    w.enter(KEEPER, 0);
    refused("ERR_NOTHING_TO_ADVANCE", || w.c.advance(U64(ids[0])));
    refused("ERR_NOTHING_TO_CHECK", || w.c.reconcile(U64(ids[2])));
}

// ---- Earned trust ----

#[test]
fn a_record_lets_the_same_share_be_paid_at_once_inside_its_allowance() {
    let mut w = World::new();
    // Everyone is paid once through a second steward: X 0.1, Y 0.05, Z 0.025.
    let (_, first) = w.chain_quest(N / 5);
    w.pay_all_countersigned(&first, 10);
    let x = w.record(X);
    assert_eq!((x.points, x.vouched.0, x.limit.0, x.room.0), (1, N / 10, N / 10, N / 10), "bounded by what a second steward approved");

    // The same job again. Each share now fits what its account has been approved for.
    let quest = w.open(NOOR, N / 5);
    w.pass(Y, quest, None);
    w.claim(X, quest, Some(Y));
    let plan = w.plan(quest, X, &[]);
    assert!(plan.shares.iter().all(|s| s.route == PayRoute::Auto));
    let ids = w.accept(NOOR, quest, X, &[]);
    assert_eq!(w.record(X).room.0, 0, "the allowance is taken when the claim is accepted");

    // Anyone can push it. The contract files and votes with no second steward.
    assert!(w.file(ids[0], 20));
    assert_eq!(w.payout(ids[0]).countersigned_by, None);
    w.settle(ids[0]);
    assert!(w.file(ids[1], 21));
    w.settle(ids[1]);
    let x = w.record(X);
    assert_eq!((x.done, x.points), (2, 2));
    assert_eq!(x.vouched.0, N / 10, "a payment made at once is not a second approval");
    assert_eq!(x.limit.0, N / 10);

    // A third job in the same period: inside the limit, over what is left of it.
    let again = w.open(NOOR, N / 5);
    w.claim(X, again, None);
    let share = &w.plan(again, X, &[]).shares[0];
    assert_eq!((share.amount.0, share.limit.0, share.room.0, share.route), (N / 10, N / 10, 0, PayRoute::Countersign));

    // A new period gives the allowance back.
    w.tick(7 * 86_400);
    assert_eq!(w.record(X).room.0, N / 10);
    assert_eq!(w.plan(again, X, &[]).shares[0].route, PayRoute::Auto);
}

#[test]
fn a_tiny_countersigned_payment_does_not_unlock_a_step() {
    let mut w = World::new();
    // X's only approved payment is 0.02 NEAR.
    let small = w.open(NOOR, N / 25);
    w.claim(X, small, None);
    let ids = w.accept(NOOR, small, X, &[]);
    w.pay_all_countersigned(&ids, 30);
    assert_eq!(w.record(X).limit.0, N / 50);
    let quest = w.open(NOOR, N / 5);
    w.claim(X, quest, None);
    assert_eq!(w.plan(quest, X, &[]).shares[0].route, PayRoute::Countersign, "0.1 NEAR is more than anyone has signed off for X");
}

#[test]
fn an_at_once_payment_left_past_its_period_needs_a_second_steward() {
    let mut w = World::new();
    let (_, first) = w.chain_quest(N / 5);
    w.pay_all_countersigned(&first, 10);
    let quest = w.open(NOOR, N / 5);
    w.claim(X, quest, None);
    let ids = w.accept(NOOR, quest, X, &[]);
    assert_eq!(w.payout(ids[0]).route, PayRoute::Auto);

    // Nobody files it. A period later it can no longer ride on the old allowance.
    w.tick(7 * 86_400 + 1);
    w.enter(KEEPER, 0);
    let step = w.c.advance(U64(ids[0]));
    assert!(matches!(step, PromiseOrValue::Value(false)));
    assert!(calls().is_empty(), "nothing was sent to the DAO");
    w.leave();
    assert_eq!(w.payout(ids[0]).route, PayRoute::Countersign);
    assert_eq!(w.record(X).room.0, N / 10, "and the new period's allowance is untouched");
    w.enter(KEEPER, 0);
    refused("ERR_NEEDS_COUNTERSIGN", || w.c.advance(U64(ids[0])));
    assert!(w.countersign(TOMAS, ids[0], 40));
    w.settle(ids[0]);
    assert_eq!(w.record(X).done, 2);
}

#[test]
fn a_decline_gives_budget_and_allowance_back_only_where_they_were_taken() {
    let mut w = World::new();
    let (_, first) = w.chain_quest(N / 5);
    w.pay_all_countersigned(&first, 10);
    let committed = w.board().committed.0;

    let quest = w.open(NOOR, N / 5);
    w.claim(X, quest, None);
    let ids = w.accept(NOOR, quest, X, &[]);
    assert_eq!(w.record(X).room.0, 0);
    assert_eq!(w.board().committed.0, committed + N / 10);
    w.enter(X, 0);
    refused("ERR_NOT_A_STEWARD", || w.c.decline(U64(ids[0]), "no".into()));
    w.enter(TOMAS, 0);
    w.c.decline(U64(ids[0]), "The work was not done".into());
    w.leave();
    assert_eq!(w.payout(ids[0]).phase, PayPhase::Declined);
    assert_eq!(w.record(X).room.0, N / 10, "the allowance came back");
    assert_eq!(w.board().committed.0, committed, "and so did the budget");
    assert_eq!(w.quest(quest).status, QuestStatus::Done);

    // The same, but declined in a later period: the new period is owed nothing.
    let late = w.open(NOOR, N / 5);
    w.claim(X, late, None);
    let ids = w.accept(NOOR, late, X, &[]);
    w.tick(7 * 86_400 + 1);
    let fresh = w.open(NOOR, N / 5);
    w.claim(X, fresh, None);
    w.accept(NOOR, fresh, X, &[]);
    assert_eq!(w.record(X).room.0, 0, "this period's allowance is spoken for");
    w.enter(TOMAS, 0);
    w.c.decline(U64(ids[0]), "Left too long".into());
    w.leave();
    assert_eq!(w.record(X).room.0, 0, "declining last period's payment frees nothing in this one");
}

// ---- Fake links, stewards' own money ----

#[test]
fn a_fake_link_can_be_left_out_and_a_proven_one_cannot() {
    let mut w = World::new();
    let (_, first) = w.chain_quest(N / 5);
    w.pay_all_countersigned(&first, 10);

    // Mallory slips an account of her own between herself and Z, who has a record.
    let quest = w.open(NOOR, N / 5);
    w.pass(Z, quest, None);
    w.pass(SOCK, quest, Some(Z));
    w.claim(MAL, quest, Some(SOCK));
    let diluted = w.plan(quest, MAL, &[]);
    assert_eq!(diluted.shares.iter().map(|s| (s.account.as_str(), s.amount.0)).collect::<Vec<_>>(), vec![(MAL, N / 10), (SOCK, N / 20), (Z, N / 40)]);
    let restored = w.plan(quest, MAL, &[SOCK]);
    assert_eq!(restored.shares.iter().map(|s| (s.account.as_str(), s.amount.0)).collect::<Vec<_>>(), vec![(MAL, N / 10), (Z, N / 20)]);
    assert_eq!(restored.passed_over, vec![acct(SOCK)]);

    w.enter(NOOR, N / 10);
    refused("ERR_CANNOT_LEAVE_OUT_A_RECORD", || w.c.accept(U64(quest), acct(MAL), vec![LeftOut { account: acct(Z), reason: "x".into() }]));
    refused("ERR_LEFT_OUT_TWICE", || {
        let twice = vec![LeftOut { account: acct(SOCK), reason: "a".into() }, LeftOut { account: acct(SOCK), reason: "b".into() }];
        w.c.accept(U64(quest), acct(MAL), twice)
    });
    refused("ERR_REASON", || w.c.accept(U64(quest), acct(MAL), vec![LeftOut { account: acct(SOCK), reason: "  ".into() }]));

    let ids = w.accept(NOOR, quest, MAL, &[SOCK]);
    assert_eq!(ids.len(), 2);
    let quest_now = w.quest(quest);
    assert_eq!(quest_now.left_out.len(), 1);
    assert_eq!((quest_now.left_out[0].account.as_str(), quest_now.left_out[0].reason.as_str()), (SOCK, "No history with us"));
    assert_eq!(w.payout(ids[0]).route, PayRoute::Countersign, "the unknown doer still needs a second steward");
    assert_eq!(w.record(SOCK).points, 0);
}

#[test]
fn stewards_cannot_decide_their_own_payments() {
    let mut w = World::new();
    // Tomas does the job himself. Noor accepts. Neither of them can be the second pair of eyes.
    let quest = w.open(NOOR, N / 5);
    w.claim(TOMAS, quest, None);
    let ids = w.accept(NOOR, quest, TOMAS, &[]);
    w.enter(TOMAS, 0);
    refused("ERR_OWN_PAYMENT", || w.c.countersign(U64(ids[0])));
    refused("ERR_OWN_PAYMENT", || w.c.decline(U64(ids[0]), "never mind".into()));
    w.enter(NOOR, 0);
    refused("ERR_SAME_STEWARD", || w.c.countersign(U64(ids[0])));
    w.enter(NOOR, N / 10);
    refused("ERR_CANNOT_ACCEPT_YOURSELF", || {
        let mine = w.c.open_quest(acct(DAO), "t".into(), "b".into(), U128(N), U64(w.now + DAY), None);
        w.c.accept(mine, acct(NOOR), vec![])
    });
}

#[test]
fn a_steward_on_the_chain_cannot_accept_a_quest_the_dao_opened() {
    let mut w = World::new();
    w.enter(DAO, N / 20);
    let quest = w.c.open_quest(acct(DAO), "By vote".into(), "b".into(), U128(2 * N), U64(w.now + DAY), None).0;
    w.leave();
    w.pass(TOMAS, quest, None);
    w.claim(X, quest, Some(TOMAS));
    w.enter(TOMAS, N / 10);
    refused("ERR_ACCEPTOR_ON_THE_CHAIN", || w.c.accept(U64(quest), acct(X), vec![]));
    // Any other steward can accept a quest the DAO opened. Only the DAO can close it.
    w.enter(NOOR, 0);
    refused("ERR_ONLY_THE_DAO", || w.c.close_quest(U64(quest)));
    assert_eq!(w.accept(NOOR, quest, X, &[]).len(), 2);
}

// ---- The DAO's own vote ----

#[test]
fn a_payment_above_the_cap_is_filed_and_left_to_the_dao() {
    let mut w = World::new();
    w.enter(DAO, N / 20);
    let quest = w.c.open_quest(acct(DAO), "Rewire the cold room".into(), "b".into(), U128(24 * N / 10), U64(w.now + DAY), None).0;
    w.leave();
    w.claim(X, quest, None);
    let ids = w.accept(TOMAS, quest, X, &[]);
    assert_eq!((w.payout(ids[0]).amount.0, w.payout(ids[0]).route), (12 * N / 10, PayRoute::Council));

    assert!(!w.file(ids[0], 50), "filed, and no vote from Grapevine");
    assert_eq!(w.payout(ids[0]).phase, PayPhase::Filed);
    w.enter(KEEPER, 0);
    refused("ERR_WAITING_FOR_THE_DAO_VOTE", || w.c.advance(U64(ids[0])));
    w.enter(NOOR, 0);
    refused("ERR_NOT_WAITING_FOR_A_COUNTERSIGN", || w.c.countersign(U64(ids[0])));
    refused("ERR_ALREADY_FILED", || w.c.decline(U64(ids[0]), "too late".into()));

    w.see(ids[0], "InProgress");
    assert_eq!(w.payout(ids[0]).phase, PayPhase::Filed);
    // The council votes on the DAO. Grapevine notes it, and counts it paid on a later look.
    w.acted_at = w.height;
    w.see(ids[0], "Approved");
    assert_eq!(w.payout(ids[0]).phase, PayPhase::Clearing);
    w.settle(ids[0]);
    let x = w.record(X);
    assert_eq!((x.done, x.vouched.0), (1, 12 * N / 10), "the DAO's vote is a second approval");
    assert_eq!(x.limit.0, N / 4);
}

#[test]
fn what_the_dao_answers_decides_how_a_payment_ends() {
    let mut w = World::new();
    let (_, ids) = w.chain_quest(2 * N);
    let committed = w.board().committed.0;
    for (i, id) in ids.iter().enumerate() {
        assert!(w.countersign(TOMAS, *id, 60 + i as u64));
    }

    // A failed read, or a proposal that is not the one filed, changes nothing.
    let x = ids[0];
    w.enter_callback(vec![]);
    refused("ERR_READ_FAILED", || w.c.on_checked(U64(x), Err(PromiseError::Failed)));
    let mut wrong = w.proposal(x, "Approved");
    wrong[0]["kind"]["Transfer"]["receiver_id"] = json!(MAL);
    refused("ERR_NOT_OUR_PROPOSAL", || w.c.on_checked(U64(x), Ok(wrong)));
    let mut bigger = w.proposal(x, "Approved");
    bigger[0]["kind"]["Transfer"]["amount"] = json!((5 * N).to_string());
    refused("ERR_NOT_OUR_PROPOSAL", || w.c.on_checked(U64(x), Ok(bigger)));
    refused("ERR_PROPOSAL_NOT_A_LIST", || w.c.on_checked(U64(x), Ok(json!({"status": "Approved"}))));
    assert_eq!(w.payout(x).phase, PayPhase::Voted);

    // Rejected by the council: unpaid, and its budget comes back.
    w.tick(60);
    w.see(x, "Rejected");
    assert_eq!(w.payout(x).phase, PayPhase::Declined);
    assert_eq!(w.board().committed.0, committed - N);
    assert_eq!(w.record(X).points, 0);

    // Gone from the DAO: unpaid, but the budget is not given back, because it may have been paid first.
    w.show(ids[1], Ok(json!([])));
    assert_eq!(w.payout(ids[1]).phase, PayPhase::Declined);
    assert_eq!(w.board().committed.0, committed - N);

    // The transfer failed on the DAO: not paid, the DAO is asked to run it again, and the wait restarts.
    let z = ids[2];
    w.enter_callback(vec![]);
    let page = w.proposal(z, "Failed");
    let next = w.c.on_checked(U64(z), Ok(page));
    assert!(matches!(next, PromiseOrValue::Promise(_)));
    drop(next);
    let retry: Vec<_> = calls().into_iter().filter(|(_, method, _, _)| method == "act_proposal").collect();
    assert_eq!(retry[0].2["action"], json!("Finalize"));
    w.leave();
    assert_eq!(w.payout(z).phase, PayPhase::Voted);
    assert_eq!(w.payout(z).since.0, w.now);
    w.enter_callback(vec![PromiseResult::Successful(vec![])]);
    w.c.on_finalized(U64(z));
    w.leave();
    assert_eq!(w.payout(z).phase, PayPhase::Voted, "nothing is concluded from a finalize");
    w.acted_at = w.height;
    w.settle(z);
    assert_eq!(w.record(Z).carried, 1);
}

#[test]
fn an_expired_proposal_is_closed_through_the_dao() {
    let mut w = World::new();
    w.enter(DAO, N / 20);
    let quest = w.c.open_quest(acct(DAO), "Big".into(), "b".into(), U128(24 * N / 10), U64(w.now + DAY), None).0;
    w.leave();
    w.claim(X, quest, None);
    let ids = w.accept(NOOR, quest, X, &[]);
    assert!(!w.file(ids[0], 70));

    // The council never votes. A week later the proposal has run out.
    w.tick(7 * 86_400 + 60);
    w.enter_callback(vec![]);
    let page = w.proposal(ids[0], "InProgress");
    let next = w.c.on_checked(U64(ids[0]), Ok(page));
    assert!(matches!(next, PromiseOrValue::Promise(_)), "the contract asks the DAO to finalize it");
    drop(next);
    assert_eq!(calls().iter().find(|(_, method, _, _)| method == "act_proposal").unwrap().2["action"], json!("Finalize"));
    w.leave();
    assert_eq!(w.payout(ids[0]).phase, PayPhase::Filed);
    w.see(ids[0], "Expired");
    assert_eq!(w.payout(ids[0]).phase, PayPhase::Declined);
    assert_eq!(w.quest(quest).status, QuestStatus::Done);
}

#[test]
fn a_retry_vote_is_not_cast_at_the_end_of_a_proposals_life() {
    let mut w = World::new();
    let (_, ids) = w.chain_quest(2 * N);
    // The first vote is refused by the DAO, say because the treasury was short.
    w.enter(TOMAS, 0);
    drop(w.c.countersign(U64(ids[0])));
    w.leave();
    let attempt = w.payout(ids[0]).attempt;
    w.enter_callback(vec![PromiseResult::Successful(b"80".to_vec())]);
    drop(w.c.on_filed(U64(ids[0]), attempt, Ok(json!(80))));
    w.leave();
    assert!(!w.dao_voted(ids[0], false));
    assert_eq!(w.payout(ids[0]).phase, PayPhase::Filed);

    // Anyone can have it vote again while the proposal is alive.
    w.enter(KEEPER, 0);
    let step = w.c.advance(U64(ids[0]));
    assert!(matches!(step, PromiseOrValue::Promise(_)));
    drop(step);
    assert_eq!(calls().iter().filter(|(_, method, _, _)| method == "act_proposal").count(), 1);
    w.leave();
    assert!(!w.dao_voted(ids[0], false));

    // But not in its last minutes: a vote then would only expire it and lose its bond.
    w.tick(7 * 86_400 - 60);
    w.enter(KEEPER, 0);
    refused("ERR_PROPOSAL_NEARLY_OVER", || w.c.advance(U64(ids[0])));
}

// ---- Things going wrong between the contract and the DAO ----

#[test]
fn a_refused_filing_puts_the_payment_back_and_a_late_answer_is_kept_as_an_orphan() {
    let mut w = World::new();
    let (_, ids) = w.chain_quest(2 * N);
    let x = ids[0];

    // The DAO refuses the proposal, or answers with something that is not a proposal id.
    w.enter(TOMAS, 0);
    drop(w.c.countersign(U64(x)));
    w.leave();
    let first = w.payout(x).attempt;
    w.enter_callback(vec![PromiseResult::Failed]);
    assert!(matches!(w.c.on_filed(U64(x), first, Err(PromiseError::Failed)), PromiseOrValue::Value(false)));
    w.leave();
    // The runtime sends a failed call's deposit back, so the bond is home again.
    w.balance += BOND;
    assert_eq!(w.payout(x).phase, PayPhase::Pending);
    w.file(x, 90);
    assert_eq!(w.payout(x).proposal_id, Some(U64(90)));

    // Another payment's filing never reports back. A steward resets it after ten minutes.
    let y = ids[1];
    w.enter(TOMAS, 0);
    drop(w.c.countersign(U64(y)));
    w.leave();
    let lost = w.payout(y).attempt;
    w.enter(TOMAS, 0);
    refused("ERR_NOT_STUCK_YET", || w.c.unstick(U64(y)));
    w.tick(601);
    w.enter(MAL, 0);
    refused("ERR_NOT_A_STEWARD", || w.c.unstick(U64(y)));
    w.enter(TOMAS, 0);
    w.c.unstick(U64(y));
    w.leave();
    assert_eq!(w.payout(y).phase, PayPhase::Pending);

    // It is filed again. Then the first call's answer turns up after all.
    w.enter(KEEPER, 0);
    drop(w.c.advance(U64(y)));
    w.leave();
    let current = w.payout(y).attempt;
    assert!(current > lost);
    w.enter_callback(vec![PromiseResult::Successful(b"91".to_vec())]);
    assert!(matches!(w.c.on_filed(U64(y), lost, Ok(json!(91))), PromiseOrValue::Value(false)));
    assert!(get_logs().iter().any(|l| l.contains("orphan_proposal")));
    w.leave();
    assert_eq!(w.payout(y).orphans, vec![U64(91)], "kept on the payment, for the council to reject");
    assert_eq!(w.payout(y).phase, PayPhase::Filing);
    // The answer to the live call is the one that counts, and the vote goes to that proposal.
    assert!(w.dao_filed(y, 92));
    assert_eq!(w.payout(y).proposal_id, Some(U64(92)));
}

#[test]
fn a_barred_account_is_paid_nothing_and_never_makes_a_callback_fail() {
    let mut w = World::new();
    let (_, ids) = w.chain_quest(2 * N);
    // The payee is barred by the DAO between the filing and its answer.
    w.enter(TOMAS, 0);
    drop(w.c.countersign(U64(ids[0])));
    w.leave();
    w.enter(MAL, 0);
    refused("ERR_NO_BOARD", || w.c.set_barred(acct(X), true));
    w.enter(DAO, 0);
    w.c.set_barred(acct(X), true);
    w.leave();
    assert!(!w.dao_filed(ids[0], 95), "the callback keeps the proposal and casts no vote");
    assert_eq!((w.payout(ids[0]).phase, w.payout(ids[0]).proposal_id), (PayPhase::Filed, Some(U64(95))));
    w.enter(KEEPER, 0);
    refused("ERR_BARRED", || w.c.advance(U64(ids[0])));
    assert_eq!(w.record(X).limit.0, 0);

    // A barred account cannot be accepted, and is passed over in a chain.
    w.enter(DAO, 0);
    w.c.set_barred(acct(Y), true);
    w.leave();
    let quest = w.open(NOOR, 2 * N);
    w.pass(Z, quest, None);
    w.pass(Y, quest, Some(Z));
    w.claim(MAL, quest, Some(Y));
    w.claim(X, quest, None);
    let plan = w.plan(quest, MAL, &[]);
    assert_eq!(plan.shares.iter().map(|s| s.account.as_str()).collect::<Vec<_>>(), vec![MAL, Z]);
    assert_eq!(plan.shares[1].amount.0, N / 2, "the next link moves up");
    w.enter(NOOR, N / 10);
    refused("ERR_BARRED", || w.c.accept(U64(quest), acct(X), vec![]));

    // Only the DAO can abandon a payment it can no longer settle.
    w.enter(TOMAS, 0);
    refused("ERR_NO_BOARD", || w.c.abandon_payout(U64(ids[0])));
    w.enter(DAO, 0);
    w.c.abandon_payout(U64(ids[0]));
    w.leave();
    assert_eq!(w.payout(ids[0]).phase, PayPhase::Declined);
    w.enter(DAO, 0);
    refused("ERR_ALREADY_CLOSED", || w.c.abandon_payout(U64(ids[0])));
}

// ---- The float, pauses, closing ----

#[test]
fn the_float_is_the_accounts_own_balance_and_only_the_dao_can_take_it() {
    let mut w = World::new();
    let cushion = N / 20;
    assert_eq!(w.board().float.0, w.balance - byte_cost_of(w.storage) - cushion);
    let (_, ids) = w.chain_quest(2 * N);
    // Each open payment holds a little back, so its callbacks can always write.
    assert_eq!(w.board().float.0, w.balance - byte_cost_of(w.storage) - cushion - 3 * (N / 100));

    w.enter(MAL, 0);
    refused("ERR_NO_BOARD", || w.c.withdraw_float(U128(1)));
    let spare = w.board().float.0;
    w.enter(DAO, 0);
    refused("ERR_FLOAT_LOW", || w.c.withdraw_float(U128(spare + 1)));
    w.enter(DAO, 0);
    drop(w.c.withdraw_float(U128(spare - BOND)));
    assert_eq!(transfers(), vec![(DAO.to_string(), spare - BOND)]);
    w.leave();
    assert_eq!(w.board().float.0, BOND);

    // One bond is left, so one payment can be filed and the next has to wait for it to return.
    assert!(w.countersign(TOMAS, ids[0], 100));
    w.enter(TOMAS, 0);
    refused("ERR_FLOAT_LOW", || w.c.countersign(U64(ids[1])));
    w.settle(ids[0]);
    assert!(w.countersign(TOMAS, ids[1], 101));
}

#[test]
fn a_claim_cannot_be_accepted_when_the_float_cannot_back_its_payments() {
    let mut w = World::new();
    let quest = w.open(NOOR, 2 * N);
    w.pass(Y, quest, None);
    w.claim(X, quest, Some(Y));
    let spare = w.board().float.0;
    w.enter(DAO, 0);
    drop(w.c.withdraw_float(U128(spare)));
    w.leave();
    w.enter(NOOR, N / 10);
    refused("ERR_FLOAT_LOW", || w.c.accept(U64(quest), acct(X), vec![]));
}

#[test]
fn any_steward_can_pause_and_only_the_dao_resumes() {
    let mut w = World::new();
    let (_, ids) = w.chain_quest(2 * N);
    w.enter(MAL, 0);
    refused("ERR_NOT_A_STEWARD", || w.c.pause(acct(DAO)));
    w.enter(TOMAS, 0);
    w.c.pause(acct(DAO));
    w.leave();
    assert_eq!(w.board().paused_by, Some(acct(TOMAS)));
    w.enter(NOOR, N / 10);
    refused("ERR_PAUSED", || w.c.open_quest(acct(DAO), "t".into(), "b".into(), U128(N), U64(w.now + DAY), None));
    w.enter(TOMAS, 0);
    refused("ERR_PAUSED", || w.c.countersign(U64(ids[0])));
    w.enter(KEEPER, 0);
    refused("ERR_PAUSED", || w.c.advance(U64(ids[0])));
    w.enter(TOMAS, 0);
    refused("ERR_NO_BOARD", || w.c.resume());
    w.enter(DAO, 0);
    w.c.resume();
    w.leave();
    assert!(w.countersign(TOMAS, ids[0], 110));
}

#[test]
fn closing_a_quest_gives_its_whole_reward_back() {
    let mut w = World::new();
    let quest = w.open(NOOR, 2 * N);
    w.pass(Z, quest, None);
    assert_eq!(w.board().committed.0, 2 * N);
    w.enter(MAL, 0);
    refused("ERR_NOT_A_STEWARD", || w.c.close_quest(U64(quest)));
    w.enter(TOMAS, 0);
    w.c.close_quest(U64(quest));
    w.leave();
    assert_eq!(w.quest(quest).status, QuestStatus::Closed);
    assert_eq!(w.board().committed.0, 0);
    w.enter(Y, N / 100);
    refused("ERR_QUEST_NOT_OPEN", || w.c.pass_on(U64(quest), None, None));
    w.enter(NOOR, 0);
    refused("ERR_QUEST_NOT_OPEN", || w.c.close_quest(U64(quest)));
}

#[test]
fn only_the_dao_changes_its_rules_and_bad_rules_are_refused() {
    let mut w = World::new();
    w.enter(NOOR, 0);
    refused("ERR_NO_BOARD", || w.c.update_board(config()));
    w.enter(DAO, 0);
    refused("ERR_SHARES_OVER_REWARD", || {
        let mut bad = config();
        bad.doer_bps = 6_000;
        w.c.update_board(bad)
    });
    refused("ERR_STEWARD_ROLE", || {
        let mut bad = config();
        bad.steward_role = "coun<cil".to_string();
        w.c.update_board(bad)
    });
    refused("ERR_SITE", || {
        let mut bad = config();
        bad.site = "javascript:alert(1)".to_string();
        w.c.update_board(bad)
    });
    let mut better = config();
    better.quest_cap = U128(3 * N);
    better.site = "https://example.org/".to_string();
    w.enter(DAO, 0);
    drop(w.c.update_board(better));
    w.leave();
    assert_eq!(w.board().config.quest_cap.0, 3 * N);
    w.enter(NOOR, N / 20);
    w.c.open_quest(acct(DAO), "Linked".into(), "b".into(), U128(3 * N), U64(w.now + DAY), None);
    assert!(posts()[0].contains("https://example.org/#quest/1"), "{}", posts()[0]);
}
