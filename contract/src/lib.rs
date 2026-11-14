//! Grapevine: word-of-mouth quests for a Sputnik DAO.
//!
//! A DAO's steward opens a quest with a reward. Anyone can pass it on, and each pass records who
//! they heard it from. When a steward accepts a claim, the reward is split between the account
//! that got it done and the chain of accounts that carried the word to them.
//!
//! The money never sits here. Every payment is an ordinary `Transfer` proposal on the DAO, filed
//! by this contract through a role that can do nothing but transfers. How each payment is approved
//! depends on the record of the account it pays:
//!
//! - inside what is left of the account's earned limit for the period, this contract's own vote
//!   passes it;
//! - above that, a second steward must countersign first;
//! - above the board's countersign cap, this contract never votes and the DAO decides as usual.
//!
//! One deployed copy serves one DAO, named when the copy is created. Nothing else can open a
//! board on it. The copy's own balance pays for storage and for the bond that rides on each
//! proposal, and that balance is read from the account, never from a counter that could drift.
//!
//! Every decision about amounts and routes lives in `grapevine-logic`, as pure functions.
//! This file is storage, permissions and promises.

use near_sdk::collections::LookupMap;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

use grapevine_logic as logic;
use grapevine_logic::{Ancestor, Budget, Next, Phase, Route, Rules, Seen};

const GAS_READ_POLICY: Gas = Gas::from_tgas(25);
const GAS_ON_SYNCED: Gas = Gas::from_tgas(25);
const GAS_ADD_PROPOSAL: Gas = Gas::from_tgas(30);
const GAS_ACT_PROPOSAL: Gas = Gas::from_tgas(100);
const GAS_ON_VOTED: Gas = Gas::from_tgas(20);
/// Covers the vote and its callback, which are scheduled from inside `on_filed`.
const GAS_ON_FILED: Gas = Gas::from_tgas(150);
const GAS_READ_PROPOSAL: Gas = Gas::from_tgas(20);
const GAS_FINALIZE: Gas = Gas::from_tgas(60);
const GAS_ON_FINALIZED: Gas = Gas::from_tgas(30);
/// Covers a finalize and its callback, which are scheduled from inside `on_checked`.
const GAS_ON_CHECKED: Gas = Gas::from_tgas(130);
/// A FastData write does no work on the receiving side, so it needs no gas of its own.
const GAS_POST: Gas = Gas::from_gas(1);
const MIN_GAS_TO_FILE: Gas = Gas::from_tgas(230);

/// Sputnik marks a proposal Approved before its transfer has run. Wait this long, then look again.
const SETTLE_NS: u64 = 20 * 1_000_000_000;
/// ... and never count it as paid while the newest action on it is younger than this many blocks.
const SETTLE_BLOCKS: u64 = 12;
/// A payment left mid-call for this long can be reset by a steward.
const STUCK_NS: u64 = 10 * 60 * 1_000_000_000;
const MAX_DEADLINE_NS: u64 = 120 * 24 * 60 * 60 * 1_000_000_000;

const MAX_TITLE: usize = 100;
const MAX_BRIEF: usize = 600;
const MAX_NOTE: usize = 280;
const MAX_REASON: usize = 140;
const MAX_SITE: usize = 120;
const MAX_ROLE: usize = 40;
const MAX_POST_REF: usize = 90;
const MAX_STEWARDS: usize = 40;
/// A pass further than this from the sponsor is refused, so a chain walk always fits in one call.
const MAX_DEPTH: u32 = 32;
const MAX_PAGE: u32 = 100;
const MIN_BOARD_DEPOSIT: u128 = logic::YOCTO / 10;
/// Kept back from the spare balance, so storage this copy has yet to write is always covered.
const STORAGE_CUSHION: u128 = logic::YOCTO / 20;
/// Kept back for each payment that is still open, so its callbacks can always write what they learn.
const PAYOUT_RESERVE: u128 = logic::YOCTO / 100;
/// A retry vote is not cast this close to a proposal's end, where it could only mark it expired.
const VOTE_MARGIN_NS: u64 = 120 * 1_000_000_000;
const MAX_ORPHANS: usize = 8;

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum Key {
    Boards,
    Quests,
    BoardQuestAt,
    Links,
    LinkAt,
    Claims,
    ClaimAt,
    Payouts,
    Records,
    PersonAt,
    Entries,
}

/// The numbers and names a DAO sets for its board, through a `FunctionCall` proposal.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct BoardConfig {
    /// The role in the DAO's policy whose members are this board's stewards.
    pub steward_role: String,
    pub doer_bps: u16,
    pub relay_bps: u16,
    pub max_hops: u8,
    pub min_cut: U128,
    pub step: U128,
    pub ceiling: U128,
    pub countersign_cap: U128,
    pub quest_cap: U128,
    pub period_cap: U128,
    pub period_ns: U64,
    /// Post each quest, split and payment to near.social from this contract's own account.
    pub announce: bool,
    /// Where the board is shown, so a post can link to a quest. May be empty.
    pub site: String,
}

impl BoardConfig {
    fn rules(&self) -> Rules {
        Rules {
            doer_bps: self.doer_bps,
            relay_bps: self.relay_bps,
            max_hops: self.max_hops,
            min_cut: self.min_cut.0,
            step: self.step.0,
            ceiling: self.ceiling.0,
            countersign_cap: self.countersign_cap.0,
            quest_cap: self.quest_cap.0,
            period_cap: self.period_cap.0,
            period_ns: self.period_ns.0,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Board {
    pub dao: AccountId,
    pub config: BoardConfig,
    /// Members of the steward role, as last read from the DAO's own policy.
    pub stewards: Vec<AccountId>,
    /// The DAO's proposal bond, as last read from its policy.
    pub bond: U128,
    pub proposal_period_ns: U64,
    /// What the DAO's policy lets this contract do, as last read.
    pub can_file: bool,
    pub can_approve: bool,
    pub can_finalize: bool,
    pub synced_at: U64,
    pub paused_by: Option<AccountId>,
    /// NEAR this copy can spend on proposal bonds right now: its balance, less what its storage
    /// locks. Worked out from the account on every read. Never reward money.
    pub float: U128,
    pub period_started: U64,
    /// Reward opened in the current period and not given back.
    pub committed: U128,
    pub quests: u32,
    pub people: u32,
    pub paid: U128,
    pub payouts_paid: u32,
    pub created_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum QuestStatus {
    Open,
    /// A claim was accepted and its payments are on their way.
    Settling,
    Done,
    /// Closed without anyone being paid.
    Closed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct LeftOut {
    pub account: AccountId,
    pub reason: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Quest {
    pub id: U64,
    pub dao: AccountId,
    pub sponsor: AccountId,
    /// Opened by the DAO's own vote, not by one steward.
    pub by_dao: bool,
    pub title: String,
    pub brief: String,
    pub reward: U128,
    pub deadline: U64,
    pub opened_at: U64,
    /// The budget period that reserved the reward.
    pub reserved_in: U64,
    pub status: QuestStatus,
    /// This contract's own near.social post about the quest, as `account/post_id`.
    pub post: Option<String>,
    /// The sponsor's own near.social post, if they gave one.
    pub sponsor_post: Option<String>,
    pub links: u32,
    pub claims: u32,
    pub doer: Option<AccountId>,
    pub accepted_by: Option<AccountId>,
    pub accepted_at: Option<U64>,
    /// Links with no record that the accepting steward left out, each with the reason given.
    pub left_out: Vec<LeftOut>,
    pub payouts: Vec<U64>,
    pub open_payouts: u32,
    pub paid: U128,
}

/// One account on a quest's vine: who they heard it from.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Link {
    /// `None` means straight from the sponsor.
    pub via: Option<AccountId>,
    pub at: U64,
    /// Their near.social post passing it on, as `account/post_id`.
    pub post: Option<String>,
    /// 1 for an account that heard it from the sponsor.
    pub depth: u32,
}

#[near(serializers = [json])]
pub struct LinkView {
    pub account: AccountId,
    pub via: Option<AccountId>,
    pub at: U64,
    pub post: Option<String>,
    pub depth: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Claim {
    pub account: AccountId,
    pub note: String,
    pub post: Option<String>,
    pub at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Part {
    /// Got the quest done.
    Doer,
    /// Passed the word along.
    Relay,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PayRoute {
    Auto,
    Countersign,
    Council,
}

impl From<Route> for PayRoute {
    fn from(r: Route) -> Self {
        match r {
            Route::Auto => PayRoute::Auto,
            Route::Countersign => PayRoute::Countersign,
            Route::Council => PayRoute::Council,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PayPhase {
    Pending,
    Filing,
    Filed,
    Voting,
    Voted,
    Clearing,
    Paid,
    Declined,
}

impl From<PayPhase> for Phase {
    fn from(p: PayPhase) -> Self {
        match p {
            PayPhase::Pending => Phase::Pending,
            PayPhase::Filing => Phase::Filing,
            PayPhase::Filed => Phase::Filed,
            PayPhase::Voting => Phase::Voting,
            PayPhase::Voted => Phase::Voted,
            PayPhase::Clearing => Phase::Clearing,
            PayPhase::Paid => Phase::Paid,
            PayPhase::Declined => Phase::Declined,
        }
    }
}

/// One payment out of the DAO's treasury, for one account's part in one quest.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Payout {
    pub id: U64,
    pub quest_id: U64,
    pub dao: AccountId,
    pub payee: AccountId,
    pub part: Part,
    /// 0 for the doer, 1 for the account that passed it to them, and so on.
    pub hop: u8,
    pub amount: U128,
    pub route: PayRoute,
    pub phase: PayPhase,
    /// The `Transfer` proposal on the DAO.
    pub proposal_id: Option<U64>,
    pub accepted_by: AccountId,
    pub countersigned_by: Option<AccountId>,
    /// When this contract voted, or first saw the DAO's own approval.
    pub since: U64,
    pub touched_at: U64,
    /// Counts calls to the DAO for this payment, so a late answer is never taken for a newer call's.
    pub attempt: u32,
    /// The budget period an at-once payment was allowed in. It has to be filed in that period.
    pub auto_period: U64,
    /// When its proposal was filed on the DAO.
    pub filed_at: U64,
    /// Proposals that a call this contract had given up on turned out to have filed after all.
    /// Grapevine never votes on these. The council should reject them.
    pub orphans: Vec<U64>,
    /// The last thing seen, in words.
    pub note: String,
}

/// A named account's standing on the board. Every number comes from entries you can list.
#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Record {
    /// Quests this account got done and was paid for.
    pub done: u32,
    /// Quests this account passed along and was paid for.
    pub carried: u32,
    pub earned: U128,
    /// Set by the DAO's vote. A barred account is paid nothing and passed over in chains.
    pub barred: bool,
    pub entries: u32,
    pub listed: bool,
    /// What has been routed to this account without a second steward in the period `auto_in`.
    pub auto_used: U128,
    pub auto_in: U64,
    /// The largest single payment to this account that a second steward or the DAO's own vote
    /// approved. The earned limit never exceeds it.
    pub vouched: U128,
}

impl Record {
    fn points(&self) -> u32 {
        self.done.saturating_add(self.carried)
    }
}

/// One point on a record: the payment it came from.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Entry {
    pub quest_id: U64,
    pub payout_id: U64,
    pub proposal_id: U64,
    pub part: Part,
    pub hop: u8,
    pub amount: U128,
    pub at: U64,
}

#[near(serializers = [json])]
pub struct RecordView {
    pub account: AccountId,
    pub done: u32,
    pub carried: u32,
    pub points: u32,
    pub earned: U128,
    pub barred: bool,
    pub entries: u32,
    /// The largest single payment a second steward or the DAO's vote approved for this account.
    pub vouched: U128,
    /// What this account can be paid in one period without a second steward.
    pub limit: U128,
    /// What is left of that in the current period.
    pub room: U128,
}

#[near(serializers = [json])]
pub struct Share {
    pub account: AccountId,
    pub part: Part,
    pub hop: u8,
    pub amount: U128,
    pub route: PayRoute,
    pub points: u32,
    pub limit: U128,
    pub room: U128,
}

#[near(serializers = [json])]
pub struct Plan {
    pub shares: Vec<Share>,
    /// Stays in the treasury.
    pub unspent: U128,
    /// Accounts on the chain that get nothing: barred, left out, or beyond the last paid hop.
    pub passed_over: Vec<AccountId>,
    /// The whole chain above the doer, nearest first.
    pub chain: Vec<AccountId>,
}

#[near(serializers = [json])]
pub struct Totals {
    pub boards: u32,
    pub quests: U64,
    pub payouts: U64,
    pub paid: U128,
}

#[allow(dead_code)]
#[ext_contract(ext_dao)]
trait SputnikDao {
    fn get_policy(&self) -> Value;
    fn get_proposals(&self, from_index: u64, limit: u64) -> Value;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Grapevine {
    /// The one DAO this copy serves. Only this account can open a board here.
    dao: AccountId,
    /// The FastData account near.social reads. Posts are function calls to it.
    social: AccountId,
    last_post_id: u64,
    quest_count: u64,
    payout_count: u64,
    /// Payments that are neither paid nor declined yet.
    open_payouts: u32,
    paid_total: u128,
    boards: LookupMap<AccountId, Board>,
    quests: LookupMap<u64, Quest>,
    board_quest_at: LookupMap<(AccountId, u32), u64>,
    links: LookupMap<(u64, AccountId), Link>,
    link_at: LookupMap<(u64, u32), AccountId>,
    claims: LookupMap<(u64, AccountId), Claim>,
    claim_at: LookupMap<(u64, u32), AccountId>,
    payouts: LookupMap<u64, Payout>,
    records: LookupMap<(AccountId, AccountId), Record>,
    person_at: LookupMap<(AccountId, u32), AccountId>,
    entries: LookupMap<(AccountId, AccountId, u32), Entry>,
}

fn now() -> u64 {
    env::block_timestamp()
}

fn emit(event: &str, data: Value) {
    let line = json!({"standard": "grapevine", "version": "1.0.0", "event": event, "data": data});
    log!("EVENT_JSON:{}", line);
}

fn byte_cost(bytes: u64) -> u128 {
    u128::from(bytes) * env::storage_byte_cost().as_yoctonear()
}

fn fail(reason: &str) -> ! {
    env::panic_str(reason)
}

/// One line of public text, inside a length, with nothing in it that could forge a field in a
/// proposal description or hide from a reader. Empty text is refused.
fn text(raw: &str, max: usize, error: &str) -> String {
    let flat = logic::one_line(&logic::plain(raw), usize::MAX);
    require!(!flat.is_empty() && flat.chars().count() <= max, error);
    flat
}

/// A near.social post reference: `account/post_id`.
fn check_post(post: &Option<String>) {
    let Some(post) = post else { return };
    let ok = post.len() <= MAX_POST_REF
        && post.split_once('/').is_some_and(|(account, id)| {
            account.parse::<AccountId>().is_ok()
                && !id.is_empty()
                && id.len() <= 16
                && id.bytes().all(|b| b.is_ascii_digit())
        });
    require!(ok, "ERR_POST_REF");
}

fn check_config(mut config: BoardConfig) -> BoardConfig {
    if let Err(reason) = logic::check_rules(&config.rules()) {
        fail(reason);
    }
    // The role's name is matched against the DAO's policy letter for letter, so an odd one is
    // refused, never cleaned up into a name that matches nothing.
    let role = config.steward_role.trim().to_string();
    require!(
        !role.is_empty() && role.chars().count() <= MAX_ROLE && logic::plain(&role) == role && !role.chars().any(char::is_control),
        "ERR_STEWARD_ROLE"
    );
    config.steward_role = role;
    config.site = logic::one_line(&logic::plain(&config.site), usize::MAX);
    require!(config.site.chars().count() <= MAX_SITE, "ERR_SITE");
    require!(
        config.site.is_empty() || config.site.starts_with("https://") || config.site.starts_with("http://"),
        "ERR_SITE"
    );
    config
}

fn transfer_kind(payout: &Payout) -> Value {
    json!({
        "Transfer": {
            "token_id": "",
            "receiver_id": payout.payee,
            "amount": payout.amount,
            "msg": Value::Null,
        }
    })
}

/// The proposal text, in the form Trezu reads as a payment request.
fn description(quest: &Quest, payout: &Payout) -> String {
    let what = match payout.part {
        Part::Doer => "for getting it done".to_string(),
        Part::Relay => format!("for passing the word along, {} from the doer", ordinal(payout.hop)),
    };
    let how = match (payout.route, &payout.countersigned_by) {
        (PayRoute::Auto, _) => "Inside the payee's earned limit, so Grapevine's vote passes it".to_string(),
        (PayRoute::Countersign, Some(by)) => format!("Countersigned by {by}"),
        (PayRoute::Countersign, None) => "Waiting for a second steward".to_string(),
        (PayRoute::Council, _) => "Above the countersign cap, so it needs the DAO's own vote".to_string(),
    };
    format!(
        "* Title: Grapevine quest #{} - {} <br>* Notes: {} NEAR to {} {}. Claim accepted by {}. {}. Grapevine payment {}.",
        quest.id.0,
        logic::one_line(&quest.title, 60),
        logic::fmt_near(payout.amount.0),
        payout.payee,
        what,
        payout.accepted_by,
        how,
        payout.id.0,
    )
}

fn ordinal(hop: u8) -> &'static str {
    match hop {
        1 => "first",
        2 => "second",
        3 => "third",
        4 => "fourth",
        5 => "fifth",
        6 => "sixth",
        7 => "seventh",
        _ => "eighth",
    }
}

fn seen_label(seen: Seen) -> &'static str {
    match seen {
        Seen::Missing => "removed from the DAO",
        Seen::InProgress { expired: false } => "waiting for votes on the DAO",
        Seen::InProgress { expired: true } => "ran out of time on the DAO",
        Seen::Approved => "approved by the DAO",
        Seen::Rejected => "rejected by the DAO",
        Seen::Removed => "removed by the DAO",
        Seen::Expired => "expired on the DAO",
        Seen::Moved => "moved off the DAO",
        Seen::Failed => "approved, but the transfer failed",
    }
}

#[near]
impl Grapevine {
    /// `dao` is the one DAO this copy will ever serve.
    #[init]
    #[private]
    pub fn new(dao: AccountId, social: Option<AccountId>) -> Self {
        Self {
            dao,
            social: social.unwrap_or_else(|| "social".parse().unwrap_or_else(|_| env::abort())),
            last_post_id: 0,
            quest_count: 0,
            payout_count: 0,
            open_payouts: 0,
            paid_total: 0,
            boards: LookupMap::new(Key::Boards),
            quests: LookupMap::new(Key::Quests),
            board_quest_at: LookupMap::new(Key::BoardQuestAt),
            links: LookupMap::new(Key::Links),
            link_at: LookupMap::new(Key::LinkAt),
            claims: LookupMap::new(Key::Claims),
            claim_at: LookupMap::new(Key::ClaimAt),
            payouts: LookupMap::new(Key::Payouts),
            records: LookupMap::new(Key::Records),
            person_at: LookupMap::new(Key::PersonAt),
            entries: LookupMap::new(Key::Entries),
        }
    }

    // ---- Called by the DAO, through an ordinary FunctionCall proposal ----

    /// Open this copy's board. Only the DAO it was created for can, so only that DAO's own vote.
    /// The attached deposit stays here as the float for proposal bonds and storage.
    #[payable]
    pub fn create_board(&mut self, config: BoardConfig) -> Promise {
        let dao = env::predecessor_account_id();
        require!(dao == self.dao, "ERR_NOT_THIS_DAO");
        require!(self.boards.get(&dao).is_none(), "ERR_BOARD_EXISTS");
        let config = check_config(config);
        require!(env::attached_deposit().as_yoctonear() >= MIN_BOARD_DEPOSIT, "ERR_DEPOSIT_TOO_SMALL");

        let board = Board {
            dao: dao.clone(),
            config,
            stewards: Vec::new(),
            bond: U128(0),
            proposal_period_ns: U64(0),
            can_file: false,
            can_approve: false,
            can_finalize: false,
            synced_at: U64(0),
            paused_by: None,
            float: U128(0),
            period_started: U64(now()),
            committed: U128(0),
            quests: 0,
            people: 0,
            paid: U128(0),
            payouts_paid: 0,
            created_at: U64(now()),
        };
        self.boards.insert(&dao, &board);
        emit("board_created", json!({"dao": dao}));
        self.read_policy(dao)
    }

    /// Change the board's rules. Payments already decided keep the route they were given.
    pub fn update_board(&mut self, config: BoardConfig) -> Promise {
        let dao = env::predecessor_account_id();
        let mut board = self.board(&dao);
        board.config = check_config(config);
        self.boards.insert(&dao, &board);
        emit("board_updated", json!({"dao": dao}));
        self.read_policy(dao)
    }

    /// Bar an account from this board, or lift the bar.
    pub fn set_barred(&mut self, account: AccountId, barred: bool) {
        let dao = env::predecessor_account_id();
        let mut board = self.board(&dao);
        let mut record = self.listed_record(&mut board, &account);
        record.barred = barred;
        self.records.insert(&(dao.clone(), account.clone()), &record);
        emit("account_barred", json!({"dao": dao, "account": account, "barred": barred}));
    }

    /// Lift a pause. Any steward can pause, only the DAO's vote can resume.
    pub fn resume(&mut self) {
        let dao = env::predecessor_account_id();
        let mut board = self.board(&dao);
        board.paused_by = None;
        self.boards.insert(&dao, &board);
        emit("board_resumed", json!({"dao": dao}));
    }

    /// Take spare float back to the DAO.
    pub fn withdraw_float(&mut self, amount: U128) -> Promise {
        let dao = env::predecessor_account_id();
        self.board(&dao);
        require!(amount.0 > 0 && amount.0 <= self.spare(), "ERR_FLOAT_LOW");
        emit("float_withdrawn", json!({"dao": dao, "amount": amount}));
        Promise::new(dao).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// Give up on a payment whose proposal can no longer be read or closed, for example after the
    /// DAO changed its contract. The payment ends unpaid, and its budget is not given back,
    /// because nothing here can prove the money did not move.
    pub fn abandon_payout(&mut self, payout_id: U64) {
        let dao = env::predecessor_account_id();
        let mut board = self.board(&dao);
        let mut payout = self.payout(payout_id.0);
        require!(payout.dao == dao, "ERR_NOT_THIS_DAO");
        require!(!matches!(payout.phase, PayPhase::Paid | PayPhase::Declined), "ERR_ALREADY_CLOSED");
        payout.note = "abandoned by the DAO's vote".to_string();
        self.close_payout(&mut payout, &mut board, false, false);
    }

    // ---- Called by anyone ----

    /// Re-read the DAO's policy: who the stewards are, the proposal bond, and what this contract may do.
    pub fn sync(&mut self, dao: AccountId) -> Promise {
        self.board(&dao);
        self.read_policy(dao)
    }

    /// Put yourself on a quest's vine, saying who you heard it from. The first answer stands.
    /// The caller pays for the storage, a few thousandths of a NEAR, and gets the rest back.
    #[payable]
    pub fn pass_on(&mut self, quest_id: U64, via: Option<AccountId>, post: Option<String>) {
        let caller = env::predecessor_account_id();
        let before = env::storage_usage();
        let mut quest = self.quest(quest_id.0);
        let via = self.join(&mut quest, &caller, via, post.clone());
        self.quests.insert(&quest.id.0, &quest);
        self.charge_caller(before);
        emit(
            "passed_on",
            json!({"quest_id": quest_id, "dao": quest.dao, "account": caller, "via": via, "post": post}),
        );
    }

    /// Say you got the quest done, or that you are the person it was looking for.
    /// If you are not on the vine yet, this puts you there under `via`.
    #[payable]
    pub fn claim(&mut self, quest_id: U64, via: Option<AccountId>, note: String, post: Option<String>) {
        let caller = env::predecessor_account_id();
        let before = env::storage_usage();
        let mut quest = self.quest(quest_id.0);
        require!(quest.status == QuestStatus::Open, "ERR_QUEST_NOT_OPEN");
        require!(now() <= quest.deadline.0, "ERR_QUEST_OVER");
        let note = text(&note, MAX_NOTE, "ERR_NOTE");
        check_post(&post);
        if self.links.get(&(quest.id.0, caller.clone())).is_none() {
            self.join(&mut quest, &caller, via, None);
        }
        require!(self.claims.get(&(quest.id.0, caller.clone())).is_none(), "ERR_ALREADY_CLAIMED");
        let claim = Claim { account: caller.clone(), note, post, at: U64(now()) };
        self.claims.insert(&(quest.id.0, caller.clone()), &claim);
        self.claim_at.insert(&(quest.id.0, quest.claims), &caller);
        quest.claims += 1;
        self.quests.insert(&quest.id.0, &quest);
        self.charge_caller(before);
        emit("claimed", json!({"quest_id": quest_id, "dao": quest.dao, "account": caller}));
    }

    /// Move a payment forward: file its transfer on the DAO, and vote when this contract may.
    ///
    /// An at-once payment has to be filed in the budget period it was allowed in. Left until a
    /// later period, it stops being at-once: this call changes its route to a countersign and
    /// answers false, so an allowance can never be saved up from one period to the next.
    pub fn advance(&mut self, payout_id: U64) -> PromiseOrValue<bool> {
        let mut payout = self.payout(payout_id.0);
        let mut board = self.board(&payout.dao);
        require!(board.paused_by.is_none(), "ERR_PAUSED");
        require!(matches!(payout.phase, PayPhase::Pending | PayPhase::Filed), "ERR_NOTHING_TO_ADVANCE");
        if payout.route == PayRoute::Auto && payout.auto_period.0 != self.current_period(&mut board) {
            payout.route = PayRoute::Countersign;
            payout.note = "left past the period it was allowed in, so it now needs a second steward".to_string();
            self.payouts.insert(&payout.id.0, &payout);
            emit("payout_rerouted", json!({"payout_id": payout_id, "dao": payout.dao, "route": "Countersign"}));
            return PromiseOrValue::Value(false);
        }
        let may_vote = payout.route == PayRoute::Auto || payout.countersigned_by.is_some();
        PromiseOrValue::Promise(match (payout.phase, payout.route) {
            (PayPhase::Pending, PayRoute::Countersign) if !may_vote => fail("ERR_NEEDS_COUNTERSIGN"),
            (PayPhase::Pending, _) => self.file(&mut payout, &board),
            (PayPhase::Filed, _) if may_vote => self.retry_vote(&mut payout, &board),
            _ => fail("ERR_WAITING_FOR_THE_DAO_VOTE"),
        })
    }

    /// Read the payment's proposal on the DAO and record what happened to it.
    pub fn reconcile(&mut self, payout_id: U64) -> Promise {
        let payout = self.payout(payout_id.0);
        require!(
            matches!(payout.phase, PayPhase::Filed | PayPhase::Voted | PayPhase::Clearing),
            "ERR_NOTHING_TO_CHECK"
        );
        let proposal_id = payout.proposal_id.unwrap_or_else(|| fail("ERR_NO_PROPOSAL")).0;
        // A list read answers "not there" with an empty page. A single read would panic instead,
        // and a panic cannot be told apart from running out of gas.
        ext_dao::ext(payout.dao)
            .with_static_gas(GAS_READ_PROPOSAL)
            .get_proposals(proposal_id, 1)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_CHECKED)
                    .on_checked(payout_id),
            )
    }

    // ---- Called by stewards ----

    /// Open a quest. A steward can open one inside the board's caps. The DAO itself can open any.
    /// The caller pays for the quest's storage, about a cent, and gets the rest of the deposit back.
    #[payable]
    pub fn open_quest(
        &mut self,
        dao: AccountId,
        title: String,
        brief: String,
        reward: U128,
        deadline: U64,
        sponsor_post: Option<String>,
    ) -> U64 {
        let caller = env::predecessor_account_id();
        let before = env::storage_usage();
        let mut board = self.board(&dao);
        let by_dao = caller == dao;
        require!(by_dao || board.stewards.contains(&caller), "ERR_NOT_A_STEWARD");
        require!(board.paused_by.is_none(), "ERR_PAUSED");
        require!(board.can_file && board.can_approve, "ERR_NOT_INSTALLED");
        let title = text(&title, MAX_TITLE, "ERR_TITLE");
        let brief = text(&brief, MAX_BRIEF, "ERR_BRIEF");
        check_post(&sponsor_post);
        let time = now();
        require!(deadline.0 > time && deadline.0 <= time.saturating_add(MAX_DEADLINE_NS), "ERR_DEADLINE");

        let rules = board.config.rules();
        require!(logic::split(reward.0, &rules, 0).doer > 0, "ERR_REWARD_TOO_SMALL");
        let budget = Budget { started_at: board.period_started.0, committed: board.committed.0 };
        let budget = logic::commit(budget, time, reward.0, &rules, by_dao).unwrap_or_else(|e| fail(e));
        board.period_started = U64(budget.started_at);
        board.committed = U128(budget.committed);

        self.quest_count += 1;
        let id = self.quest_count;
        let post = board.config.announce.then(|| {
            let link = if board.config.site.is_empty() {
                String::new()
            } else {
                format!(" {}#quest/{}", board.config.site, id)
            };
            self.post(
                format!(
                    "New quest from @{dao}: {title}. Reward: {} NEAR. Whoever gets it done is paid, and so is everyone who passed the word along.{link} #grapevine",
                    logic::fmt_near(reward.0)
                ),
                None,
            )
        });
        let quest = Quest {
            id: U64(id),
            dao: dao.clone(),
            sponsor: caller.clone(),
            by_dao,
            title,
            brief,
            reward,
            deadline,
            opened_at: U64(time),
            reserved_in: U64(budget.started_at),
            status: QuestStatus::Open,
            post,
            sponsor_post,
            links: 0,
            claims: 0,
            doer: None,
            accepted_by: None,
            accepted_at: None,
            left_out: Vec::new(),
            payouts: Vec::new(),
            open_payouts: 0,
            paid: U128(0),
        };
        self.quests.insert(&id, &quest);
        self.board_quest_at.insert(&(dao.clone(), board.quests), &id);
        board.quests += 1;
        self.boards.insert(&dao, &board);
        self.charge_caller(before);
        emit(
            "quest_opened",
            json!({"quest_id": U64(id), "dao": dao, "sponsor": caller, "reward": reward, "by_dao": by_dao}),
        );
        U64(id)
    }

    /// Accept a claim. The reward is split between the doer and the chain that reached them, and
    /// each share becomes a payment with its own route.
    ///
    /// A steward's quest can be accepted by that steward, or by the DAO. A quest the DAO opened
    /// by vote can be accepted by any steward. `leave_out` drops links from the chain, each with
    /// a public reason, and only links with no record can be dropped.
    ///
    /// The caller pays for the storage of the payments this creates, and gets the rest of the
    /// deposit back.
    #[payable]
    pub fn accept(&mut self, quest_id: U64, doer: AccountId, leave_out: Vec<LeftOut>) -> Vec<U64> {
        let caller = env::predecessor_account_id();
        let before = env::storage_usage();
        let mut quest = self.quest(quest_id.0);
        let mut board = self.board(&quest.dao);
        require!(quest.status == QuestStatus::Open, "ERR_QUEST_NOT_OPEN");
        require!(board.paused_by.is_none(), "ERR_PAUSED");
        if caller != quest.dao {
            require!(board.stewards.contains(&caller), "ERR_NOT_A_STEWARD");
            require!(quest.by_dao || caller == quest.sponsor, "ERR_NOT_THE_SPONSOR");
        }
        require!(doer != caller, "ERR_CANNOT_ACCEPT_YOURSELF");
        require!(self.claims.get(&(quest.id.0, doer.clone())).is_some(), "ERR_NO_CLAIM");
        require!(leave_out.len() <= MAX_DEPTH as usize, "ERR_TOO_MANY_LEFT_OUT");
        let left_out: Vec<LeftOut> = leave_out
            .into_iter()
            .map(|l| LeftOut { account: l.account, reason: text(&l.reason, MAX_REASON, "ERR_REASON") })
            .collect();
        let names: Vec<AccountId> = left_out.iter().map(|l| l.account.clone()).collect();
        require!(
            names.iter().enumerate().all(|(i, a)| !names[..i].contains(a)),
            "ERR_LEFT_OUT_TWICE"
        );

        // The allowance below is per budget period, so make sure the period is the current one.
        let time = now();
        let period = self.current_period(&mut board);

        let plan = self.plan(&quest, &board, &doer, &names).unwrap_or_else(|e| fail(e));
        // A steward who is on the chain would be deciding their own payment.
        require!(!plan.chain.contains(&caller), "ERR_ACCEPTOR_ON_THE_CHAIN");

        let mut ids = Vec::new();
        let mut lines = Vec::new();
        for share in &plan.shares {
            self.payout_count += 1;
            let id = self.payout_count;
            let payout = Payout {
                id: U64(id),
                quest_id: quest.id,
                dao: quest.dao.clone(),
                payee: share.account.clone(),
                part: share.part,
                hop: share.hop,
                amount: share.amount,
                route: share.route,
                phase: PayPhase::Pending,
                proposal_id: None,
                accepted_by: caller.clone(),
                countersigned_by: None,
                since: U64(0),
                touched_at: U64(time),
                attempt: 0,
                auto_period: U64(if share.route == PayRoute::Auto { period } else { 0 }),
                filed_at: U64(0),
                orphans: Vec::new(),
                note: "decided".to_string(),
            };
            self.payouts.insert(&id, &payout);
            self.open_payouts += 1;
            if share.route == PayRoute::Auto {
                // Take it out of what this account can be paid without a second steward this period.
                let key = (quest.dao.clone(), share.account.clone());
                let mut record = self.records.get(&key).unwrap_or_default();
                if record.auto_in.0 != period {
                    record.auto_in = U64(period);
                    record.auto_used = U128(0);
                }
                record.auto_used = U128(record.auto_used.0.saturating_add(share.amount.0));
                self.records.insert(&key, &record);
            }
            ids.push(U64(id));
            lines.push(format!("@{} {} NEAR", share.account, logic::fmt_near(share.amount.0)));
        }

        // Whatever the split leaves over goes back to the period's budget.
        let budget = Budget { started_at: board.period_started.0, committed: board.committed.0 };
        board.committed = U128(logic::release(budget, quest.reserved_in.0, plan.unspent.0).committed);

        quest.status = if ids.is_empty() { QuestStatus::Done } else { QuestStatus::Settling };
        quest.doer = Some(doer.clone());
        quest.accepted_by = Some(caller.clone());
        quest.accepted_at = Some(U64(time));
        quest.left_out = left_out;
        quest.payouts = ids.clone();
        quest.open_payouts = ids.len() as u32;
        if board.config.announce && !lines.is_empty() {
            self.post(
                format!(
                    "Quest #{} was done by @{doer}. Shares: {}. From the treasury of @{}. #grapevine",
                    quest.id.0,
                    lines.join(", "),
                    quest.dao
                ),
                quest.post.clone(),
            );
        }
        self.quests.insert(&quest.id.0, &quest);
        self.boards.insert(&quest.dao, &board);
        self.charge_caller(before);
        // Every open payment keeps a little of this copy's balance back for what its callbacks
        // will write. If that is not there, the claim cannot be accepted until the float is topped up.
        require!(self.covered(), "ERR_FLOAT_LOW");
        emit(
            "claim_accepted",
            json!({
                "quest_id": quest_id,
                "dao": quest.dao,
                "doer": doer,
                "accepted_by": caller,
                "payouts": ids,
                "unspent": plan.unspent,
                // The reasons are on the quest. An event has a size limit, so it names accounts only.
                "left_out": names,
            }),
        );
        ids
    }

    /// Be the second pair of eyes on a payment above what the payee can be paid at once.
    /// The countersigner cannot be the steward who accepted the claim, or the payee.
    pub fn countersign(&mut self, payout_id: U64) -> Promise {
        let caller = env::predecessor_account_id();
        let mut payout = self.payout(payout_id.0);
        let board = self.board(&payout.dao);
        require!(board.paused_by.is_none(), "ERR_PAUSED");
        require!(board.stewards.contains(&caller), "ERR_NOT_A_STEWARD");
        require!(
            matches!(payout.phase, PayPhase::Pending | PayPhase::Filed)
                && payout.route == PayRoute::Countersign
                && payout.countersigned_by.is_none(),
            "ERR_NOT_WAITING_FOR_A_COUNTERSIGN"
        );
        require!(caller != payout.accepted_by, "ERR_SAME_STEWARD");
        require!(caller != payout.payee, "ERR_OWN_PAYMENT");
        payout.countersigned_by = Some(caller.clone());
        emit(
            "payout_countersigned",
            json!({"payout_id": payout_id, "dao": payout.dao, "by": caller}),
        );
        if payout.phase == PayPhase::Pending {
            self.file(&mut payout, &board)
        } else {
            // Its proposal is already on the DAO: an at-once payment that was left too long.
            self.retry_vote(&mut payout, &board)
        }
    }

    /// Stop a payment that has not been filed yet. The money stays in the treasury.
    pub fn decline(&mut self, payout_id: U64, reason: String) {
        let caller = env::predecessor_account_id();
        let mut payout = self.payout(payout_id.0);
        let mut board = self.board(&payout.dao);
        require!(caller == payout.dao || board.stewards.contains(&caller), "ERR_NOT_A_STEWARD");
        require!(caller != payout.payee, "ERR_OWN_PAYMENT");
        require!(payout.phase == PayPhase::Pending, "ERR_ALREADY_FILED");
        payout.note = format!("declined by {caller}: {}", text(&reason, MAX_REASON, "ERR_REASON"));
        self.close_payout(&mut payout, &mut board, false, true);
    }

    /// Close an open quest without paying anyone. A quest the DAO opened by vote can only be
    /// closed by the DAO.
    pub fn close_quest(&mut self, quest_id: U64) {
        let caller = env::predecessor_account_id();
        let mut quest = self.quest(quest_id.0);
        let mut board = self.board(&quest.dao);
        if quest.by_dao {
            require!(caller == quest.dao, "ERR_ONLY_THE_DAO");
        } else {
            require!(
                caller == quest.dao || caller == quest.sponsor || board.stewards.contains(&caller),
                "ERR_NOT_A_STEWARD"
            );
        }
        require!(quest.status == QuestStatus::Open, "ERR_QUEST_NOT_OPEN");
        quest.status = QuestStatus::Closed;
        let budget = Budget { started_at: board.period_started.0, committed: board.committed.0 };
        board.committed = U128(logic::release(budget, quest.reserved_in.0, quest.reward.0).committed);
        self.quests.insert(&quest.id.0, &quest);
        self.boards.insert(&quest.dao, &board);
        emit("quest_closed", json!({"quest_id": quest_id, "dao": quest.dao, "by": caller}));
    }

    /// Stop new quests, accepts and payments on a board. Only the DAO's vote can resume.
    pub fn pause(&mut self, dao: AccountId) {
        let caller = env::predecessor_account_id();
        let mut board = self.board(&dao);
        require!(caller == dao || board.stewards.contains(&caller), "ERR_NOT_A_STEWARD");
        board.paused_by = Some(caller.clone());
        self.boards.insert(&dao, &board);
        emit("board_paused", json!({"dao": dao, "by": caller}));
    }

    /// Reset a payment whose call to the DAO never reported back. If that call did reach the DAO
    /// after all, its late answer is ignored and logged as an orphan proposal for the council to
    /// reject.
    pub fn unstick(&mut self, payout_id: U64) {
        let caller = env::predecessor_account_id();
        let mut payout = self.payout(payout_id.0);
        let board = self.board(&payout.dao);
        require!(caller == payout.dao || board.stewards.contains(&caller), "ERR_NOT_A_STEWARD");
        require!(now() >= payout.touched_at.0.saturating_add(STUCK_NS), "ERR_NOT_STUCK_YET");
        payout.phase = match payout.phase {
            PayPhase::Filing => PayPhase::Pending,
            PayPhase::Voting => PayPhase::Filed,
            _ => fail("ERR_NOT_STUCK"),
        };
        payout.attempt += 1;
        payout.touched_at = U64(now());
        payout.note = format!("reset by {caller}");
        self.payouts.insert(&payout.id.0, &payout);
        emit("payout_reset", json!({"payout_id": payout_id, "dao": payout.dao, "by": caller}));
    }

    // ---- Callbacks ----

    #[private]
    pub fn on_synced(&mut self, dao: AccountId, #[callback_result] policy: Result<Value, PromiseError>) -> bool {
        let Some(mut board) = self.boards.get(&dao) else {
            return false;
        };
        let me = env::current_account_id();
        let facts = match policy
            .map_err(|_| "ERR_POLICY_READ_FAILED")
            .and_then(|p| logic::policy_facts(&p, &board.config.steward_role, me.as_str()))
        {
            Ok(facts) => facts,
            Err(reason) => {
                emit("sync_failed", json!({"dao": dao, "reason": reason}));
                return false;
            }
        };
        // A role too large to keep is not kept in part, and nobody from an older read stays on:
        // the board has no stewards until the role is smaller. Everything else is still updated.
        let too_many = facts.stewards.len() > MAX_STEWARDS;
        if too_many {
            emit("sync_failed", json!({"dao": dao, "reason": "ERR_TOO_MANY_STEWARDS"}));
        }
        board.stewards = if too_many {
            Vec::new()
        } else {
            facts.stewards.iter().filter_map(|s| s.parse().ok()).collect()
        };
        board.bond = U128(facts.bond);
        board.proposal_period_ns = U64(facts.proposal_period_ns);
        board.can_file = facts.can_file;
        board.can_approve = facts.can_approve;
        board.can_finalize = facts.can_finalize;
        board.synced_at = U64(now());
        self.boards.insert(&dao, &board);
        emit(
            "board_synced",
            json!({
                "dao": dao,
                "stewards": board.stewards,
                "bond": board.bond,
                "can_file": board.can_file,
                "can_approve": board.can_approve,
                "can_finalize": board.can_finalize,
            }),
        );
        true
    }

    #[private]
    pub fn on_filed(
        &mut self,
        payout_id: U64,
        attempt: u32,
        #[callback_result] filed: Result<Value, PromiseError>,
    ) -> PromiseOrValue<bool> {
        let mut payout = self.payout(payout_id.0);
        let proposal_id = filed.ok().and_then(|v| v.as_u64());
        if payout.phase != PayPhase::Filing || payout.attempt != attempt {
            // An answer to a call that was given up on. If it did file a proposal, say so loudly:
            // Grapevine will never vote on it, and the council should reject it.
            if let Some(id) = proposal_id {
                if payout.orphans.len() < MAX_ORPHANS && !payout.orphans.contains(&U64(id)) {
                    payout.orphans.push(U64(id));
                    self.payouts.insert(&payout.id.0, &payout);
                }
                emit(
                    "orphan_proposal",
                    json!({"payout_id": payout_id, "dao": payout.dao, "proposal_id": U64(id)}),
                );
            }
            return PromiseOrValue::Value(false);
        }
        payout.touched_at = U64(now());
        match proposal_id {
            Some(id) => {
                payout.proposal_id = Some(U64(id));
                payout.phase = PayPhase::Filed;
                payout.filed_at = U64(now());
                payout.note = "filed on the DAO".to_string();
                self.payouts.insert(&payout.id.0, &payout);
                emit(
                    "payout_filed",
                    json!({"payout_id": payout_id, "dao": payout.dao, "proposal_id": U64(id)}),
                );
                // Nothing on this path may panic: a callback that fails forgets the proposal it
                // has just learned of. A payee barred in the meantime simply gets no vote.
                let may_vote = payout.route == PayRoute::Auto || payout.countersigned_by.is_some();
                if may_vote && !self.record(&payout.dao, &payout.payee).barred {
                    PromiseOrValue::Promise(self.cast_vote(&mut payout))
                } else {
                    PromiseOrValue::Value(true)
                }
            }
            None => {
                // The DAO refused the proposal, so the bond came straight back to this account.
                payout.phase = PayPhase::Pending;
                payout.note = "the DAO refused the proposal".to_string();
                self.payouts.insert(&payout.id.0, &payout);
                emit("filing_failed", json!({"payout_id": payout_id, "dao": payout.dao}));
                PromiseOrValue::Value(false)
            }
        }
    }

    #[private]
    pub fn on_voted(&mut self, payout_id: U64, attempt: u32) -> bool {
        let mut payout = self.payout(payout_id.0);
        if payout.phase != PayPhase::Voting || payout.attempt != attempt {
            return false;
        }
        let voted = near_sdk::is_promise_success();
        payout.touched_at = U64(now());
        if voted {
            payout.phase = PayPhase::Voted;
            payout.since = U64(now());
            payout.note = "Grapevine voted to approve".to_string();
        } else {
            // Usually means the DAO took the role away, or already decided the proposal itself.
            payout.phase = PayPhase::Filed;
            payout.note = "the vote was refused by the DAO".to_string();
        }
        self.payouts.insert(&payout.id.0, &payout);
        emit(
            if voted { "payout_voted" } else { "vote_failed" },
            json!({"payout_id": payout_id, "dao": payout.dao, "proposal_id": payout.proposal_id}),
        );
        voted
    }

    #[private]
    pub fn on_checked(
        &mut self,
        payout_id: U64,
        #[callback_result] read: Result<Value, PromiseError>,
    ) -> PromiseOrValue<String> {
        let mut payout = self.payout(payout_id.0);
        let mut board = self.board(&payout.dao);
        require!(
            matches!(payout.phase, PayPhase::Filed | PayPhase::Voted | PayPhase::Clearing),
            "ERR_NOTHING_TO_CHECK"
        );
        // A failed read tells us nothing, so nothing may change. The caller can simply retry.
        let page = read.unwrap_or_else(|_| fail("ERR_READ_FAILED"));
        let proposal_id = payout.proposal_id.unwrap_or_else(|| fail("ERR_NO_PROPOSAL")).0;
        let me = env::current_account_id();
        let time = now();
        let facts = logic::proposal_facts(
            &page,
            proposal_id,
            me.as_str(),
            payout.payee.as_str(),
            payout.amount.0,
            time,
            board.proposal_period_ns.0,
        )
        .unwrap_or_else(|e| fail(e));
        require!(facts.seen == Seen::Missing || facts.ours, "ERR_NOT_OUR_PROPOSAL");

        let label = seen_label(facts.seen);
        payout.note = label.to_string();
        let settled = logic::is_settled(facts.last_action_height, env::block_height(), SETTLE_BLOCKS);
        match logic::after_check(payout.phase.into(), facts.seen, payout.since.0, time, SETTLE_NS, settled) {
            Next::Clearing => {
                payout.phase = PayPhase::Clearing;
                payout.since = U64(time);
                payout.touched_at = U64(time);
                self.payouts.insert(&payout.id.0, &payout);
            }
            Next::Paid => self.close_payout(&mut payout, &mut board, true, false),
            Next::Declined { refund_budget } => self.close_payout(&mut payout, &mut board, false, refund_budget),
            Next::Finalize => {
                self.payouts.insert(&payout.id.0, &payout);
                if board.can_finalize {
                    return PromiseOrValue::Promise(self.finalize(&payout));
                }
            }
            Next::Stay => {
                if facts.seen == Seen::Failed {
                    // The transfer failed after approval. Start the wait again, and ask the DAO to
                    // run it once more when the policy lets this contract do that.
                    payout.since = U64(time);
                    self.payouts.insert(&payout.id.0, &payout);
                    if board.can_finalize {
                        return PromiseOrValue::Promise(self.finalize(&payout));
                    }
                } else {
                    self.payouts.insert(&payout.id.0, &payout);
                }
            }
        }
        PromiseOrValue::Value(label.to_string())
    }

    /// After a finalize, nothing is concluded here. The next `reconcile` reads what the DAO did.
    #[private]
    pub fn on_finalized(&mut self, payout_id: U64) -> String {
        let mut payout = self.payout(payout_id.0);
        if !matches!(payout.phase, PayPhase::Filed | PayPhase::Voted | PayPhase::Clearing) {
            return "nothing to do".to_string();
        }
        payout.note = if near_sdk::is_promise_success() {
            "asked the DAO to finalize the proposal".to_string()
        } else {
            "the DAO refused to finalize the proposal".to_string()
        };
        payout.since = U64(now());
        self.payouts.insert(&payout.id.0, &payout);
        payout.note
    }

    // ---- Views ----

    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }

    /// The one DAO this copy serves.
    pub fn dao(&self) -> AccountId {
        self.dao.clone()
    }

    pub fn social_account(&self) -> AccountId {
        self.social.clone()
    }

    pub fn totals(&self) -> Totals {
        Totals {
            boards: u32::from(self.boards.get(&self.dao).is_some()),
            quests: U64(self.quest_count),
            payouts: U64(self.payout_count),
            paid: U128(self.paid_total),
        }
    }

    pub fn get_board(&self, dao: AccountId) -> Option<Board> {
        self.boards.get(&dao).map(|mut board| {
            board.float = U128(self.spare());
            board
        })
    }

    pub fn list_boards(&self) -> Vec<AccountId> {
        self.boards.get(&self.dao).map(|b| vec![b.dao]).unwrap_or_default()
    }

    pub fn get_quest(&self, quest_id: U64) -> Option<Quest> {
        self.quests.get(&quest_id.0)
    }

    /// A board's quests, oldest first.
    pub fn list_quests(&self, dao: AccountId, from_index: u32, limit: u32) -> Vec<Quest> {
        let count = self.boards.get(&dao).map_or(0, |b| b.quests);
        (from_index..count.min(from_index.saturating_add(limit.min(MAX_PAGE))))
            .filter_map(|i| self.board_quest_at.get(&(dao.clone(), i)))
            .filter_map(|id| self.quests.get(&id))
            .collect()
    }

    /// Everyone on a quest's vine, in the order they joined.
    pub fn list_links(&self, quest_id: U64, from_index: u32, limit: u32) -> Vec<LinkView> {
        let count = self.quests.get(&quest_id.0).map_or(0, |q| q.links);
        (from_index..count.min(from_index.saturating_add(limit.min(MAX_PAGE))))
            .filter_map(|i| self.link_at.get(&(quest_id.0, i)))
            .filter_map(|account| {
                self.links.get(&(quest_id.0, account.clone())).map(|l| LinkView {
                    account,
                    via: l.via,
                    at: l.at,
                    post: l.post,
                    depth: l.depth,
                })
            })
            .collect()
    }

    pub fn get_link(&self, quest_id: U64, account: AccountId) -> Option<Link> {
        self.links.get(&(quest_id.0, account))
    }

    pub fn list_claims(&self, quest_id: U64, from_index: u32, limit: u32) -> Vec<Claim> {
        let count = self.quests.get(&quest_id.0).map_or(0, |q| q.claims);
        (from_index..count.min(from_index.saturating_add(limit.min(MAX_PAGE))))
            .filter_map(|i| self.claim_at.get(&(quest_id.0, i)))
            .filter_map(|account| self.claims.get(&(quest_id.0, account)))
            .collect()
    }

    pub fn get_payout(&self, payout_id: U64) -> Option<Payout> {
        self.payouts.get(&payout_id.0)
    }

    pub fn list_payouts(&self, quest_id: U64) -> Vec<Payout> {
        self.quests
            .get(&quest_id.0)
            .map(|q| q.payouts.iter().filter_map(|id| self.payouts.get(&id.0)).collect())
            .unwrap_or_default()
    }

    /// What accepting `doer`'s claim would pay, to whom, and by which route. Changes nothing.
    pub fn preview(&self, quest_id: U64, doer: AccountId, leave_out: Vec<AccountId>) -> Plan {
        let quest = self.quest(quest_id.0);
        let board = self.board(&quest.dao);
        self.plan(&quest, &board, &doer, &leave_out).unwrap_or_else(|e| fail(e))
    }

    pub fn get_record(&self, dao: AccountId, account: AccountId) -> RecordView {
        let record = self.records.get(&(dao.clone(), account.clone())).unwrap_or_default();
        let (limit, room) = self.boards.get(&dao).map_or((0, 0), |b| self.allowance(&b, &record));
        RecordView {
            account,
            done: record.done,
            carried: record.carried,
            points: record.points(),
            earned: record.earned,
            barred: record.barred,
            entries: record.entries,
            vouched: record.vouched,
            limit: U128(limit),
            room: U128(room),
        }
    }

    /// The payments behind an account's record, oldest first.
    pub fn list_entries(&self, dao: AccountId, account: AccountId, from_index: u32, limit: u32) -> Vec<Entry> {
        let count = self.records.get(&(dao.clone(), account.clone())).map_or(0, |r| r.entries);
        (from_index..count.min(from_index.saturating_add(limit.min(MAX_PAGE))))
            .filter_map(|i| self.entries.get(&(dao.clone(), account.clone(), i)))
            .collect()
    }

    /// Everyone with a record on a board, in the order they first appeared.
    pub fn list_people(&self, dao: AccountId, from_index: u32, limit: u32) -> Vec<RecordView> {
        let count = self.boards.get(&dao).map_or(0, |b| b.people);
        (from_index..count.min(from_index.saturating_add(limit.min(MAX_PAGE))))
            .filter_map(|i| self.person_at.get(&(dao.clone(), i)))
            .map(|account| self.get_record(dao.clone(), account))
            .collect()
    }
}

impl Grapevine {
    fn board(&self, dao: &AccountId) -> Board {
        self.boards.get(dao).unwrap_or_else(|| fail("ERR_NO_BOARD"))
    }

    fn quest(&self, id: u64) -> Quest {
        self.quests.get(&id).unwrap_or_else(|| fail("ERR_NO_QUEST"))
    }

    fn payout(&self, id: u64) -> Payout {
        self.payouts.get(&id).unwrap_or_else(|| fail("ERR_NO_PAYOUT"))
    }

    fn record(&self, dao: &AccountId, account: &AccountId) -> Record {
        self.records.get(&(dao.clone(), account.clone())).unwrap_or_default()
    }

    /// The account's record, added to the board's list of people the first time it is touched.
    fn listed_record(&mut self, board: &mut Board, account: &AccountId) -> Record {
        let mut record = self.record(&board.dao, account);
        if !record.listed {
            record.listed = true;
            self.person_at.insert(&(board.dao.clone(), board.people), account);
            board.people += 1;
            self.boards.insert(&board.dao, board);
        }
        record
    }

    /// NEAR this copy holds beyond what its storage locks. This is what a proposal bond can come
    /// out of. It is read from the account itself, so it cannot drift from what is really there.
    fn spare(&self) -> u128 {
        env::account_balance().as_yoctonear().saturating_sub(self.held_back())
    }

    /// What must stay in the account: the stake for its storage, a cushion, and a reserve for
    /// each open payment, so that a callback never fails for want of a few bytes.
    fn held_back(&self) -> u128 {
        byte_cost(env::storage_usage())
            .saturating_add(STORAGE_CUSHION)
            .saturating_add(u128::from(self.open_payouts) * PAYOUT_RESERVE)
    }

    fn covered(&self) -> bool {
        env::account_balance().as_yoctonear() >= self.held_back()
    }

    /// The start of the budget period that is running now. Starts a new one when the old has ended.
    fn current_period(&mut self, board: &mut Board) -> u64 {
        let budget = Budget { started_at: board.period_started.0, committed: board.committed.0 };
        let rolled = logic::roll(budget, now(), board.config.period_ns.0);
        if rolled.started_at != board.period_started.0 {
            board.period_started = U64(rolled.started_at);
            board.committed = U128(rolled.committed);
            self.boards.insert(&board.dao, board);
        }
        rolled.started_at
    }

    /// Votes again on a proposal that is already filed, unless the payee is barred or the
    /// proposal is about to run out. A vote cast after a proposal's period only marks it expired,
    /// and Sputnik then keeps its bond, so that is left to `reconcile` to close.
    fn retry_vote(&mut self, payout: &mut Payout, board: &Board) -> Promise {
        require!(!self.record(&payout.dao, &payout.payee).barred, "ERR_BARRED");
        let ends = payout.filed_at.0.saturating_add(board.proposal_period_ns.0);
        require!(now().saturating_add(VOTE_MARGIN_NS) < ends, "ERR_PROPOSAL_NEARLY_OVER");
        self.cast_vote(payout)
    }

    /// An account's earned limit for a period, and what is left of it in the current one.
    fn allowance(&self, board: &Board, record: &Record) -> (u128, u128) {
        if record.barred {
            return (0, 0);
        }
        let rules = board.config.rules();
        let budget = Budget { started_at: board.period_started.0, committed: board.committed.0 };
        let period = logic::roll(budget, now(), rules.period_ns).started_at;
        let limit = logic::earned_limit(record.points(), record.vouched.0, &rules);
        (limit, logic::auto_room(limit, record.auto_used.0, record.auto_in.0, period))
    }

    /// Bills the caller's deposit for storage this call added, and sends the rest back.
    fn charge_caller(&mut self, before: u64) {
        let cost = byte_cost(env::storage_usage().saturating_sub(before));
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= cost, "ERR_ATTACH_STORAGE_DEPOSIT");
        let change = attached - cost;
        if change > 0 {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(change))
                .detach();
        }
    }

    fn read_policy(&self, dao: AccountId) -> Promise {
        ext_dao::ext(dao.clone())
            .with_static_gas(GAS_READ_POLICY)
            .get_policy()
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_SYNCED)
                    .on_synced(dao),
            )
    }

    /// Writes a post to near.social from this contract's own account, and returns its reference.
    ///
    /// near.social is a FastData namespace: a post is a function call to the `social` account,
    /// which has no contract, so the receipt fails by design and the indexer picks the data up
    /// anyway. The author is the predecessor, which here is this contract.
    fn post(&mut self, body: String, quote: Option<String>) -> String {
        let id = env::block_timestamp_ms().max(self.last_post_id + 1);
        self.last_post_id = id;
        let mut value = json!({"text": body});
        if let Some(quote) = quote {
            value["quote"] = Value::String(quote);
        }
        let mut args = serde_json::Map::new();
        args.insert(format!("post/{id}"), value);
        Promise::new(self.social.clone())
            .function_call(
                "__fastdata_kv".to_string(),
                serde_json::to_vec(&Value::Object(args)).unwrap_or_else(|_| env::abort()),
                NearToken::from_yoctonear(0),
                GAS_POST,
            )
            .detach();
        format!("{}/{}", env::current_account_id(), id)
    }

    /// Adds `who` to the quest's vine under `via`. Returns the parent that was recorded.
    fn join(
        &mut self,
        quest: &mut Quest,
        who: &AccountId,
        via: Option<AccountId>,
        post: Option<String>,
    ) -> Option<AccountId> {
        require!(quest.status == QuestStatus::Open, "ERR_QUEST_NOT_OPEN");
        require!(now() <= quest.deadline.0, "ERR_QUEST_OVER");
        require!(who != &quest.sponsor && who != &quest.dao, "ERR_SPONSOR_CANNOT_JOIN");
        require!(self.links.get(&(quest.id.0, who.clone())).is_none(), "ERR_ALREADY_ON_THE_VINE");
        check_post(&post);
        // Hearing it from the sponsor is the same as hearing it from nobody in between.
        let via = via.filter(|v| v != &quest.sponsor && v != &quest.dao);
        let depth = match &via {
            None => 1,
            Some(parent) => {
                require!(parent != who, "ERR_SELF_REFERRAL");
                let link = self
                    .links
                    .get(&(quest.id.0, parent.clone()))
                    .unwrap_or_else(|| fail("ERR_UNKNOWN_REFERRER"));
                link.depth + 1
            }
        };
        require!(depth <= MAX_DEPTH, "ERR_CHAIN_TOO_DEEP");
        let link = Link { via: via.clone(), at: U64(now()), post, depth };
        self.links.insert(&(quest.id.0, who.clone()), &link);
        self.link_at.insert(&(quest.id.0, quest.links), who);
        quest.links += 1;
        via
    }

    /// Works out who would be paid what if `doer`'s claim were accepted.
    fn plan(&self, quest: &Quest, board: &Board, doer: &AccountId, leave_out: &[AccountId]) -> Result<Plan, &'static str> {
        let rules = board.config.rules();
        let doer_record = self.record(&quest.dao, doer);
        if doer_record.barred {
            return Err("ERR_BARRED");
        }
        let link = self.links.get(&(quest.id.0, doer.clone())).ok_or("ERR_NOT_ON_THE_VINE")?;

        // Walk from the doer up to the sponsor.
        let mut chain: Vec<AccountId> = Vec::new();
        let mut records: Vec<Record> = Vec::new();
        let mut next = link.via;
        while let Some(account) = next {
            if chain.len() as u32 >= MAX_DEPTH {
                return Err("ERR_CHAIN_TOO_DEEP");
            }
            next = self.links.get(&(quest.id.0, account.clone())).and_then(|l| l.via);
            records.push(self.record(&quest.dao, &account));
            chain.push(account);
        }
        if leave_out.iter().any(|a| !chain.contains(a)) {
            return Err("ERR_LEFT_OUT_NOT_ON_THE_CHAIN");
        }
        let ancestors: Vec<Ancestor> = chain
            .iter()
            .zip(&records)
            .map(|(account, record)| Ancestor {
                points: record.points(),
                barred: record.barred,
                left_out: leave_out.contains(account),
            })
            .collect();
        let picked = logic::paid_ancestors(&ancestors, rules.max_hops)?;
        let split = logic::split(quest.reward.0, &rules, picked.len());

        let share = |account: &AccountId, record: &Record, part: Part, hop: u8, amount: u128| {
            let (limit, room) = self.allowance(board, record);
            Share {
                account: account.clone(),
                part,
                hop,
                amount: U128(amount),
                route: logic::route(amount, room, &rules).into(),
                points: record.points(),
                limit: U128(limit),
                room: U128(room),
            }
        };
        let mut shares = Vec::new();
        if split.doer > 0 {
            shares.push(share(doer, &doer_record, Part::Doer, 0, split.doer));
        }
        let mut paid: Vec<usize> = Vec::new();
        for (k, cut) in split.relays.iter().enumerate() {
            let i = picked[k];
            paid.push(i);
            shares.push(share(&chain[i], &records[i], Part::Relay, (k + 1) as u8, *cut));
        }
        let passed_over = chain
            .iter()
            .enumerate()
            .filter(|(i, _)| !paid.contains(i))
            .map(|(_, a)| a.clone())
            .collect();
        Ok(Plan { shares, unspent: U128(split.unspent), passed_over, chain })
    }

    /// Files the payment's `Transfer` proposal on the DAO, with the bond from this copy's balance.
    fn file(&mut self, payout: &mut Payout, board: &Board) -> Promise {
        require!(env::prepaid_gas() >= MIN_GAS_TO_FILE, "ERR_ATTACH_MORE_GAS");
        require!(board.can_file, "ERR_NOT_INSTALLED");
        require!(!self.record(&payout.dao, &payout.payee).barred, "ERR_BARRED");
        let bond = board.bond.0;
        require!(self.spare() >= bond, "ERR_FLOAT_LOW");

        payout.phase = PayPhase::Filing;
        payout.attempt += 1;
        payout.touched_at = U64(now());
        self.payouts.insert(&payout.id.0, payout);

        let quest = self.quest(payout.quest_id.0);
        let args = json!({
            "proposal": {
                "description": description(&quest, payout),
                "kind": transfer_kind(payout),
            }
        });
        Promise::new(payout.dao.clone())
            .function_call(
                "add_proposal".to_string(),
                serde_json::to_vec(&args).unwrap_or_else(|_| env::abort()),
                NearToken::from_yoctonear(bond),
                GAS_ADD_PROPOSAL,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_FILED)
                    .on_filed(payout.id, payout.attempt),
            )
    }

    /// Votes to approve the payment's own proposal. This contract never votes on anything else.
    fn cast_vote(&mut self, payout: &mut Payout) -> Promise {
        let proposal_id = payout.proposal_id.unwrap_or_else(|| fail("ERR_NO_PROPOSAL"));
        payout.phase = PayPhase::Voting;
        payout.attempt += 1;
        payout.touched_at = U64(now());
        self.payouts.insert(&payout.id.0, payout);
        let args = json!({
            "id": proposal_id.0,
            "action": "VoteApprove",
            "proposal": transfer_kind(payout),
            "memo": format!("Grapevine payment {} for quest {}", payout.id.0, payout.quest_id.0),
        });
        Promise::new(payout.dao.clone())
            .function_call(
                "act_proposal".to_string(),
                serde_json::to_vec(&args).unwrap_or_else(|_| env::abort()),
                NearToken::from_yoctonear(0),
                GAS_ACT_PROPOSAL,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_VOTED)
                    .on_voted(payout.id, payout.attempt),
            )
    }

    /// Asks the DAO to finalize the payment's proposal: close it if it expired, or run a failed transfer again.
    fn finalize(&self, payout: &Payout) -> Promise {
        let proposal_id = payout.proposal_id.unwrap_or_else(|| fail("ERR_NO_PROPOSAL"));
        let args = json!({
            "id": proposal_id.0,
            "action": "Finalize",
            "proposal": transfer_kind(payout),
        });
        Promise::new(payout.dao.clone())
            .function_call(
                "act_proposal".to_string(),
                serde_json::to_vec(&args).unwrap_or_else(|_| env::abort()),
                NearToken::from_yoctonear(0),
                GAS_FINALIZE,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_FINALIZED)
                    .on_finalized(payout.id),
            )
    }

    /// Ends a payment as paid or declined, and settles everything that hangs on it.
    /// `refund_budget` gives a declined payment's share back to the period that reserved it.
    fn close_payout(&mut self, payout: &mut Payout, board: &mut Board, paid: bool, refund_budget: bool) {
        let time = now();
        let mut quest = self.quest(payout.quest_id.0);
        payout.touched_at = U64(time);

        if paid {
            payout.phase = PayPhase::Paid;
            let mut record = self.listed_record(board, &payout.payee);
            let entry = Entry {
                quest_id: payout.quest_id,
                payout_id: payout.id,
                proposal_id: payout.proposal_id.unwrap_or(U64(0)),
                part: payout.part,
                hop: payout.hop,
                amount: payout.amount,
                at: U64(time),
            };
            self.entries.insert(&(payout.dao.clone(), payout.payee.clone(), record.entries), &entry);
            record.entries += 1;
            match payout.part {
                Part::Doer => record.done += 1,
                Part::Relay => record.carried += 1,
            }
            record.earned = U128(record.earned.0.saturating_add(payout.amount.0));
            if payout.route != PayRoute::Auto {
                // A second steward, or the DAO's own vote, approved this amount for this account.
                record.vouched = U128(record.vouched.0.max(payout.amount.0));
            }
            self.records.insert(&(payout.dao.clone(), payout.payee.clone()), &record);

            board.paid = U128(board.paid.0.saturating_add(payout.amount.0));
            board.payouts_paid += 1;
            self.paid_total = self.paid_total.saturating_add(payout.amount.0);
            quest.paid = U128(quest.paid.0.saturating_add(payout.amount.0));
            if board.config.announce {
                let what = match payout.part {
                    Part::Doer => format!("getting quest #{} done", quest.id.0),
                    Part::Relay => format!("passing quest #{} along", quest.id.0),
                };
                self.post(
                    format!(
                        "@{} was paid {} NEAR for {what}. Proposal #{} of @{}. #grapevine",
                        payout.payee,
                        logic::fmt_near(payout.amount.0),
                        entry.proposal_id.0,
                        payout.dao
                    ),
                    quest.post.clone(),
                );
            }
        } else {
            payout.phase = PayPhase::Declined;
            if refund_budget {
                // The money never moved, so its share of the period's budget comes back,
                // and so does the payee's allowance if it was going to be paid at once.
                let budget = Budget { started_at: board.period_started.0, committed: board.committed.0 };
                board.committed = U128(logic::release(budget, quest.reserved_in.0, payout.amount.0).committed);
                if payout.route == PayRoute::Auto {
                    let key = (payout.dao.clone(), payout.payee.clone());
                    let mut record = self.records.get(&key).unwrap_or_default();
                    // Only into the period it was taken from. A later period owes it nothing.
                    if record.auto_in == payout.auto_period {
                        record.auto_used = U128(record.auto_used.0.saturating_sub(payout.amount.0));
                        self.records.insert(&key, &record);
                    }
                }
            }
        }

        self.open_payouts = self.open_payouts.saturating_sub(1);
        quest.open_payouts = quest.open_payouts.saturating_sub(1);
        if quest.open_payouts == 0 {
            quest.status = QuestStatus::Done;
        }
        self.quests.insert(&quest.id.0, &quest);
        self.payouts.insert(&payout.id.0, payout);
        self.boards.insert(&board.dao, board);
        emit(
            if paid { "payout_paid" } else { "payout_declined" },
            json!({
                "payout_id": payout.id,
                "quest_id": payout.quest_id,
                "dao": payout.dao,
                "payee": payout.payee,
                "amount": payout.amount,
                "proposal_id": payout.proposal_id,
                "note": payout.note,
            }),
        );
    }
}

#[cfg(test)]
mod tests;
