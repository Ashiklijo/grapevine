//! Every decision Grapevine makes about money, as pure functions.
//!
//! Nothing here touches the NEAR runtime, so the rules can be read and tested on their own:
//! `cargo test -p grapevine-logic`.
//!
//! The rules in one place:
//!
//! 1. **The split.** Whoever gets a quest done receives `doer_bps` of the reward. The person who
//!    passed it to them receives `relay_bps`, the person before that half as much, and so on for
//!    at most `max_hops` people. Whatever is left is never asked from the treasury.
//! 2. **The route.** Each payment is routed on its own, by the record of the account it pays:
//!    inside that account's earned limit it is paid at once, above it a second steward must
//!    countersign, and above `countersign_cap` it is left to the DAO's ordinary vote.
//! 3. **The budget.** Stewards can only open quests inside the cap the DAO set for each period.

use serde_json::Value;

pub type Balance = u128;

pub const BPS: u128 = 10_000;
pub const YOCTO: Balance = 1_000_000_000_000_000_000_000_000;
/// No chain is ever paid deeper than this, whatever a board asks for.
pub const HARD_MAX_HOPS: u8 = 8;

const MINUTE_NS: u64 = 60 * 1_000_000_000;
const DAY_NS: u64 = 24 * 60 * MINUTE_NS;

/// The numbers a DAO sets for its board.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rules {
    /// Share of the reward for the account that got the quest done, in basis points.
    pub doer_bps: u16,
    /// Share for the nearest account that passed the quest on. Each hop further gets half.
    pub relay_bps: u16,
    /// How many accounts up the chain are paid.
    pub max_hops: u8,
    /// Shares smaller than this are not paid at all.
    pub min_cut: Balance,
    /// Each point on an account's record raises its earned limit by this much.
    pub step: Balance,
    /// An earned limit never goes above this.
    pub ceiling: Balance,
    /// A payment above this is left to the DAO's ordinary vote.
    pub countersign_cap: Balance,
    /// The largest reward one steward can open. Bigger quests are opened by the DAO itself.
    pub quest_cap: Balance,
    /// The total reward stewards can open in one period.
    pub period_cap: Balance,
    /// Length of a budget period, in nanoseconds.
    pub period_ns: u64,
}

/// Refuses numbers that would let a quest pay out more than its reward, or that make no sense.
pub fn check_rules(r: &Rules) -> Result<(), &'static str> {
    if r.doer_bps < 1_000 || r.doer_bps > 10_000 {
        return Err("ERR_DOER_SHARE");
    }
    // 1 + 1/2 + 1/4 + ... stays below 2, so the chain can never take more than twice the first cut.
    if r.doer_bps as u128 + 2 * r.relay_bps as u128 > BPS {
        return Err("ERR_SHARES_OVER_REWARD");
    }
    if r.max_hops > HARD_MAX_HOPS {
        return Err("ERR_TOO_MANY_HOPS");
    }
    if r.min_cut == 0 {
        return Err("ERR_MIN_CUT");
    }
    if r.ceiling > r.countersign_cap {
        return Err("ERR_CEILING_OVER_COUNTERSIGN_CAP");
    }
    if r.quest_cap == 0 || r.quest_cap > r.period_cap {
        return Err("ERR_QUEST_CAP");
    }
    if r.period_ns < MINUTE_NS || r.period_ns > 366 * DAY_NS {
        return Err("ERR_PERIOD");
    }
    Ok(())
}

/// How one reward is divided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Split {
    pub doer: Balance,
    /// Nearest to the doer first.
    pub relays: Vec<Balance>,
    /// Stays in the treasury.
    pub unspent: Balance,
}

/// Divides `reward` between the doer and `hops` accounts up the chain.
///
/// Shares are rounded down, and a share below `min_cut` is dropped together with every share
/// after it, so the total never exceeds the reward.
pub fn split(reward: Balance, rules: &Rules, hops: usize) -> Split {
    let doer = reward / BPS * rules.doer_bps as u128 + (reward % BPS) * rules.doer_bps as u128 / BPS;
    let first = reward / BPS * rules.relay_bps as u128 + (reward % BPS) * rules.relay_bps as u128 / BPS;
    let mut relays = Vec::new();
    let limit = hops.min(rules.max_hops as usize).min(HARD_MAX_HOPS as usize);
    for hop in 0..limit {
        let cut = first >> hop;
        if cut < rules.min_cut {
            break;
        }
        relays.push(cut);
    }
    let doer = if doer < rules.min_cut { 0 } else { doer };
    let paid: Balance = doer + relays.iter().sum::<Balance>();
    Split { doer, relays, unspent: reward.saturating_sub(paid) }
}

/// One account between the sponsor and the doer, nearest to the doer first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ancestor {
    /// Finished payouts on this account's record.
    pub points: u32,
    /// The DAO has barred this account.
    pub barred: bool,
    /// The steward accepting the claim asked to leave this account out.
    pub left_out: bool,
}

/// Which ancestors are paid, as indexes into `chain`, nearest first.
///
/// A barred account is passed over. So is one the accepting steward left out, but only an account
/// with no record can be left out: a steward cannot cut a proven contributor out of a chain.
pub fn paid_ancestors(chain: &[Ancestor], max_hops: u8) -> Result<Vec<usize>, &'static str> {
    let mut picked = Vec::new();
    for (i, a) in chain.iter().enumerate() {
        if a.left_out && a.points > 0 {
            return Err("ERR_CANNOT_LEAVE_OUT_A_RECORD");
        }
        if a.barred || a.left_out {
            continue;
        }
        if picked.len() < max_hops.min(HARD_MAX_HOPS) as usize {
            picked.push(i);
        }
    }
    Ok(picked)
}

/// How much an account can be paid in a period without a second person, from its record.
///
/// `vouched` is the largest single payment a second steward or the DAO's own vote has approved
/// for this account. The limit never exceeds it, so a tiny countersigned payment cannot unlock
/// a large limit: an account is trusted with at most what someone else has already signed off.
pub fn earned_limit(points: u32, vouched: Balance, rules: &Rules) -> Balance {
    rules.step.saturating_mul(points as u128).min(rules.ceiling).min(vouched)
}

/// What is left of an earned limit in the current budget period.
///
/// The limit is an allowance per period, not per payment: however many quests one steward
/// accepts, an account is never paid more than its earned limit in a period without a second
/// steward. `used_in` is the period the `used` amount belongs to.
pub fn auto_room(limit: Balance, used: Balance, used_in: u64, period_started: u64) -> Balance {
    if used_in == period_started {
        limit.saturating_sub(used)
    } else {
        limit
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// Inside the payee's earned limit: Grapevine's own vote passes the transfer.
    Auto,
    /// A second steward must countersign before Grapevine votes.
    Countersign,
    /// Grapevine files the transfer and never votes. The DAO decides the ordinary way.
    Council,
}

/// `room` is what is left of the payee's earned limit in this period.
pub fn route(amount: Balance, room: Balance, rules: &Rules) -> Route {
    if amount <= room {
        Route::Auto
    } else if amount <= rules.countersign_cap {
        Route::Countersign
    } else {
        Route::Council
    }
}

/// A board's running budget for the current period.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    pub started_at: u64,
    pub committed: Balance,
}

/// Starts a fresh period when the old one has run out.
pub fn roll(budget: Budget, now: u64, period_ns: u64) -> Budget {
    if now >= budget.started_at.saturating_add(period_ns) {
        Budget { started_at: now, committed: 0 }
    } else {
        budget
    }
}

/// Reserves `reward` in the current period, or refuses.
pub fn commit(budget: Budget, now: u64, reward: Balance, rules: &Rules, by_dao: bool) -> Result<Budget, &'static str> {
    if reward == 0 {
        return Err("ERR_NO_REWARD");
    }
    // The DAO's own vote can open a quest of any size. A steward acting alone cannot.
    if !by_dao && reward > rules.quest_cap {
        return Err("ERR_OVER_QUEST_CAP");
    }
    let rolled = roll(budget, now, rules.period_ns);
    let committed = rolled.committed.checked_add(reward).ok_or("ERR_OVERFLOW")?;
    if !by_dao && committed > rules.period_cap {
        return Err("ERR_OVER_PERIOD_CAP");
    }
    Ok(Budget { started_at: rolled.started_at, committed })
}

/// Gives back what a quest did not use, but only inside the period that reserved it.
pub fn release(budget: Budget, reserved_in: u64, amount: Balance) -> Budget {
    if reserved_in == budget.started_at {
        Budget { started_at: budget.started_at, committed: budget.committed.saturating_sub(amount) }
    } else {
        budget
    }
}

/// Where a payment is on its way out of the treasury.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Decided, no proposal on the DAO yet.
    Pending,
    /// `add_proposal` is in flight.
    Filing,
    /// The proposal exists. Waiting for a countersign, or for the DAO's vote.
    Filed,
    /// Grapevine's `act_proposal` is in flight.
    Voting,
    /// Grapevine voted. Waiting to see that the transfer really ran.
    Voted,
    /// The DAO approved it by its own vote. Waiting to see that the transfer really ran.
    Clearing,
    Paid,
    Declined,
}

/// What a read of the DAO's proposal showed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Seen {
    /// The read succeeded and the proposal is gone from the DAO.
    Missing,
    InProgress { expired: bool },
    Approved,
    Rejected,
    Removed,
    Expired,
    Moved,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Next {
    Stay,
    /// Seen approved for the first time: note when, and look again after the settle delay.
    Clearing,
    Paid,
    /// `refund_budget` is false when the proposal vanished from the DAO, because a proposal that
    /// was removed may have been paid first.
    Declined { refund_budget: bool },
    /// The proposal ran out of time. Ask the DAO to close it so the bond comes back.
    Finalize,
}

/// Decides what a payment becomes after a read of its proposal.
///
/// Sputnik marks a proposal Approved before its transfer has run, and flips it to Failed if the
/// transfer then fails. So Approved only counts once it has been seen at least `settle_ns` after
/// the vote, in a later transaction.
///
/// `settled` is false while the newest action on the proposal is too recent for its transfer to
/// have finished. That covers a council member re-running a failed transfer directly on the DAO.
pub fn after_check(phase: Phase, seen: Seen, since: u64, now: u64, settle_ns: u64, settled: bool) -> Next {
    match phase {
        Phase::Filed | Phase::Voted | Phase::Clearing => {}
        _ => return Next::Stay,
    }
    match seen {
        Seen::Approved => match phase {
            Phase::Filed => Next::Clearing,
            _ if settled && now >= since.saturating_add(settle_ns) => Next::Paid,
            _ => Next::Stay,
        },
        Seen::InProgress { expired: true } => Next::Finalize,
        Seen::InProgress { expired: false } | Seen::Failed => Next::Stay,
        Seen::Rejected | Seen::Expired => Next::Declined { refund_budget: true },
        Seen::Removed | Seen::Moved | Seen::Missing => Next::Declined { refund_budget: false },
    }
}

/// What Grapevine needs to know from a DAO's policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyFacts {
    /// Members of the steward role.
    pub stewards: Vec<String>,
    pub bond: Balance,
    pub proposal_period_ns: u64,
    /// Grapevine sits in a group role that may file transfers.
    pub can_file: bool,
    /// ... that may approve them, with a vote policy its own vote satisfies.
    pub can_approve: bool,
    /// ... and that may close expired ones.
    pub can_finalize: bool,
}

fn as_u128(v: &Value) -> Option<u128> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_u64().map(|x| x as u128),
        _ => None,
    }
}

fn grants(permissions: &[&str], kind: &str, action: &str) -> bool {
    permissions.iter().any(|p| {
        let mut parts = p.splitn(2, ':');
        let k = parts.next().unwrap_or("");
        let a = parts.next().unwrap_or("");
        (k == "*" || k == kind) && (a == "*" || a == action)
    })
}

/// True when one vote from a group of `members` satisfies this role's rule for transfers.
fn one_vote_passes(role: &Value, default_policy: &Value, members: usize) -> bool {
    let policy = role
        .get("vote_policy")
        .and_then(|vp| vp.get("transfer"))
        .unwrap_or(default_policy);
    if policy.get("weight_kind").and_then(Value::as_str) != Some("RoleWeight") {
        return false;
    }
    let quorum = policy.get("quorum").and_then(as_u128).unwrap_or(0);
    let weight = match policy.get("threshold") {
        // A ratio [num, den]: Sputnik needs min(num * total / den + 1, total) votes.
        Some(Value::Array(r)) if r.len() == 2 => {
            let num = as_u128(&r[0]).unwrap_or(1);
            let den = as_u128(&r[1]).unwrap_or(1).max(1);
            (num.saturating_mul(members as u128) / den).saturating_add(1).min(members as u128)
        }
        // A fixed weight: Sputnik needs min(weight, total) votes.
        Some(other) => as_u128(other).map_or(u128::MAX, |w| w.min(members as u128)),
        None => u128::MAX,
    };
    quorum.max(weight) <= 1
}

/// Reads a Sputnik `get_policy` answer given as text.
pub fn parse_policy(json: &str, steward_role: &str, me: &str) -> Result<PolicyFacts, &'static str> {
    let v: Value = serde_json::from_str(json).map_err(|_| "ERR_POLICY_NOT_JSON")?;
    policy_facts(&v, steward_role, me)
}

/// Reads a Sputnik `get_policy` answer.
pub fn policy_facts(v: &Value, steward_role: &str, me: &str) -> Result<PolicyFacts, &'static str> {
    let roles = v.get("roles").and_then(Value::as_array).ok_or("ERR_POLICY_NO_ROLES")?;
    let bond = v.get("proposal_bond").and_then(as_u128).ok_or("ERR_POLICY_NO_BOND")?;
    let period = v.get("proposal_period").and_then(as_u128).ok_or("ERR_POLICY_NO_PERIOD")?;
    let default_policy = v.get("default_vote_policy").cloned().unwrap_or(Value::Null);

    let mut facts = PolicyFacts {
        stewards: Vec::new(),
        bond,
        proposal_period_ns: u64::try_from(period).map_err(|_| "ERR_POLICY_PERIOD")?,
        can_file: false,
        can_approve: false,
        can_finalize: false,
    };
    for role in roles {
        let name = role.get("name").and_then(Value::as_str).unwrap_or("");
        let group: Vec<&str> = role
            .get("kind")
            .and_then(|k| k.get("Group"))
            .and_then(Value::as_array)
            .map(|g| g.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let everyone = role.get("kind").and_then(Value::as_str) == Some("Everyone");
        let permissions: Vec<&str> = role
            .get("permissions")
            .and_then(Value::as_array)
            .map(|p| p.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();

        if name == steward_role {
            for member in &group {
                if !facts.stewards.iter().any(|s| s == member) {
                    facts.stewards.push((*member).to_string());
                }
            }
        }
        let mine = group.contains(&me);
        if (mine || everyone) && grants(&permissions, "transfer", "AddProposal") {
            facts.can_file = true;
        }
        if mine && grants(&permissions, "transfer", "VoteApprove") && one_vote_passes(role, &default_policy, group.len()) {
            facts.can_approve = true;
        }
        if mine && grants(&permissions, "transfer", "Finalize") {
            facts.can_finalize = true;
        }
    }
    Ok(facts)
}

/// What a read of one proposal showed, checked against the payment Grapevine filed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProposalFacts {
    pub seen: Seen,
    /// The proposal is the transfer Grapevine filed: same proposer, receiver and amount, in NEAR.
    pub ours: bool,
    /// Block height of the newest vote or finalize on the proposal, when the DAO reports one.
    pub last_action_height: Option<u64>,
}

/// Reads a Sputnik `get_proposals({from_index: id, limit: 1})` answer given as text.
pub fn parse_proposal(
    json: &str,
    id: u64,
    me: &str,
    receiver: &str,
    amount: Balance,
    now: u64,
    proposal_period_ns: u64,
) -> Result<ProposalFacts, &'static str> {
    let v: Value = serde_json::from_str(json).map_err(|_| "ERR_PROPOSAL_NOT_JSON")?;
    proposal_facts(&v, id, me, receiver, amount, now, proposal_period_ns)
}

/// Reads a Sputnik `get_proposals({from_index: id, limit: 1})` answer.
///
/// An empty list is positive proof the proposal was removed, because the call itself succeeded.
pub fn proposal_facts(
    v: &Value,
    id: u64,
    me: &str,
    receiver: &str,
    amount: Balance,
    now: u64,
    proposal_period_ns: u64,
) -> Result<ProposalFacts, &'static str> {
    let list = v.as_array().ok_or("ERR_PROPOSAL_NOT_A_LIST")?;
    let Some(p) = list.iter().find(|p| p.get("id").and_then(Value::as_u64) == Some(id)) else {
        return Ok(ProposalFacts { seen: Seen::Missing, ours: false, last_action_height: None });
    };
    let submitted = p.get("submission_time").and_then(as_u128).unwrap_or(0) as u64;
    let seen = match p.get("status").and_then(Value::as_str).ok_or("ERR_PROPOSAL_NO_STATUS")? {
        "InProgress" => Seen::InProgress { expired: now > submitted.saturating_add(proposal_period_ns) },
        "Approved" => Seen::Approved,
        "Rejected" => Seen::Rejected,
        "Removed" => Seen::Removed,
        "Expired" => Seen::Expired,
        "Moved" => Seen::Moved,
        "Failed" => Seen::Failed,
        _ => return Err("ERR_PROPOSAL_STATUS"),
    };
    let transfer = p.get("kind").and_then(|k| k.get("Transfer"));
    let ours = p.get("proposer").and_then(Value::as_str) == Some(me)
        && transfer.is_some_and(|t| {
            t.get("receiver_id").and_then(Value::as_str) == Some(receiver)
                && t.get("amount").and_then(as_u128) == Some(amount)
                && t.get("token_id").and_then(Value::as_str).unwrap_or("") == ""
        });
    let last_action_height = p
        .get("last_actions_log")
        .and_then(Value::as_array)
        .and_then(|log| log.iter().filter_map(|e| e.get("block_height").and_then(as_u128)).max())
        .map(|h| h as u64);
    Ok(ProposalFacts { seen, ours, last_action_height })
}

/// True once the newest action on a proposal is at least `blocks` old, so anything it set off has
/// finished. A DAO that reports no action log is taken at its word.
pub fn is_settled(last_action_height: Option<u64>, block_height: u64, blocks: u64) -> bool {
    last_action_height.map_or(true, |h| block_height >= h.saturating_add(blocks))
}

/// yoctoNEAR as a short decimal, rounded down to four places: "2.5", "0.125", "<0.0001".
pub fn fmt_near(yocto: Balance) -> String {
    let unit = YOCTO / 10_000;
    let scaled = yocto / unit;
    if scaled == 0 {
        return if yocto == 0 { "0".to_string() } else { "<0.0001".to_string() };
    }
    let whole = scaled / 10_000;
    let frac = scaled % 10_000;
    if frac == 0 {
        return whole.to_string();
    }
    let digits = format!("{frac:04}");
    format!("{whole}.{}", digits.trim_end_matches('0'))
}

/// Removes what could forge a field in a proposal description or hide text from a reader:
/// angle brackets, asterisks, and invisible or direction-changing characters.
pub fn plain(text: &str) -> String {
    text.chars()
        .filter(|&c| {
            !matches!(c, '<' | '>' | '*')
                && !matches!(
                    c as u32,
                    0x00AD | 0x061C | 0x115F | 0x1160 | 0x180E | 0x200B..=0x200F | 0x2028..=0x202E | 0x2060..=0x2064
                        | 0x2066..=0x2069 | 0x3164 | 0xFE00..=0xFE0F | 0xFEFF | 0xFFA0 | 0xE0000..=0xE007F
                )
        })
        .collect()
}

/// Keeps text that goes into a public post or a proposal on one line and inside a length.
pub fn one_line(text: &str, max_chars: usize) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let trimmed = flat.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut cut: String = trimmed.chars().take(max_chars.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

#[cfg(test)]
mod tests {
    use super::*;

    const N: Balance = YOCTO;

    fn rules() -> Rules {
        Rules {
            doer_bps: 5_000,
            relay_bps: 2_500,
            max_hops: 5,
            min_cut: N / 100,
            step: N,
            ceiling: 5 * N,
            countersign_cap: 10 * N,
            quest_cap: 20 * N,
            period_cap: 60 * N,
            period_ns: 30 * DAY_NS,
        }
    }

    #[test]
    fn default_rules_are_valid() {
        assert_eq!(check_rules(&rules()), Ok(()));
    }

    #[test]
    fn rules_that_could_overpay_are_refused() {
        let mut r = rules();
        r.doer_bps = 6_000;
        r.relay_bps = 2_500;
        assert_eq!(check_rules(&r), Err("ERR_SHARES_OVER_REWARD"));
        r = rules();
        r.doer_bps = 500;
        assert_eq!(check_rules(&r), Err("ERR_DOER_SHARE"));
        r = rules();
        r.max_hops = 9;
        assert_eq!(check_rules(&r), Err("ERR_TOO_MANY_HOPS"));
        r = rules();
        r.ceiling = 11 * N;
        assert_eq!(check_rules(&r), Err("ERR_CEILING_OVER_COUNTERSIGN_CAP"));
        r = rules();
        r.quest_cap = 61 * N;
        assert_eq!(check_rules(&r), Err("ERR_QUEST_CAP"));
        r = rules();
        r.period_ns = 1;
        assert_eq!(check_rules(&r), Err("ERR_PERIOD"));
        r = rules();
        r.min_cut = 0;
        assert_eq!(check_rules(&r), Err("ERR_MIN_CUT"));
    }

    #[test]
    fn the_split_halves_up_the_chain() {
        let s = split(8 * N, &rules(), 3);
        assert_eq!(s.doer, 4 * N);
        assert_eq!(s.relays, vec![2 * N, N, N / 2]);
        assert_eq!(s.unspent, N / 2);
    }

    #[test]
    fn with_nobody_in_between_half_stays_in_the_treasury() {
        let s = split(8 * N, &rules(), 0);
        assert_eq!(s.doer, 4 * N);
        assert!(s.relays.is_empty());
        assert_eq!(s.unspent, 4 * N);
    }

    #[test]
    fn a_split_never_pays_more_than_the_reward() {
        let r = rules();
        for reward in [1u128, 7, 9_999, 10_001, N / 3, N, 17 * N + 13, u128::MAX / 20_000] {
            for hops in 0..12 {
                let s = split(reward, &r, hops);
                let paid = s.doer + s.relays.iter().sum::<Balance>();
                assert!(paid <= reward, "reward {reward} hops {hops} paid {paid}");
                assert_eq!(paid + s.unspent, reward);
                assert!(s.relays.len() <= r.max_hops as usize);
            }
        }
    }

    #[test]
    fn the_most_generous_valid_rules_still_fit_inside_the_reward() {
        let mut r = rules();
        r.doer_bps = 1_000;
        r.relay_bps = 4_500;
        r.max_hops = HARD_MAX_HOPS;
        r.min_cut = 1;
        assert_eq!(check_rules(&r), Ok(()));
        let s = split(1_000_000 * N, &r, 50);
        assert_eq!(s.relays.len(), HARD_MAX_HOPS as usize);
        assert!(s.doer + s.relays.iter().sum::<Balance>() <= 1_000_000 * N);
    }

    #[test]
    fn dust_shares_are_dropped() {
        let mut r = rules();
        r.min_cut = N / 4;
        // 1 NEAR reward: relays would be 0.25, 0.125, ... Only the first clears the floor.
        let s = split(N, &r, 4);
        assert_eq!(s.relays, vec![N / 4]);
        assert_eq!(s.doer, N / 2);
        assert_eq!(s.unspent, N / 4);
    }

    #[test]
    fn deep_chains_stop_at_max_hops() {
        let mut r = rules();
        r.max_hops = 2;
        let s = split(8 * N, &r, 6);
        assert_eq!(s.relays, vec![2 * N, N]);
    }

    fn anc(points: u32) -> Ancestor {
        Ancestor { points, barred: false, left_out: false }
    }

    #[test]
    fn barred_and_left_out_accounts_are_passed_over() {
        let chain = [
            Ancestor { points: 0, barred: false, left_out: true },
            anc(2),
            Ancestor { points: 4, barred: true, left_out: false },
            anc(0),
        ];
        assert_eq!(paid_ancestors(&chain, 5), Ok(vec![1, 3]));
    }

    #[test]
    fn leaving_out_fake_links_restores_the_honest_share() {
        // Two fake accounts sit between the doer and an honest relayer.
        let honest_only = split(8 * N, &rules(), 1);
        let chain = [
            Ancestor { points: 0, barred: false, left_out: true },
            Ancestor { points: 0, barred: false, left_out: true },
            anc(1),
        ];
        let picked = paid_ancestors(&chain, 5).unwrap();
        assert_eq!(picked, vec![2]);
        let s = split(8 * N, &rules(), picked.len());
        assert_eq!(s.relays, honest_only.relays);
        assert_eq!(s.relays[0], 2 * N);
    }

    #[test]
    fn an_account_with_a_record_cannot_be_left_out() {
        let chain = [Ancestor { points: 1, barred: false, left_out: true }];
        assert_eq!(paid_ancestors(&chain, 5), Err("ERR_CANNOT_LEAVE_OUT_A_RECORD"));
    }

    #[test]
    fn only_max_hops_ancestors_are_picked() {
        let chain = [anc(0); 7];
        assert_eq!(paid_ancestors(&chain, 3).unwrap(), vec![0, 1, 2]);
    }

    #[test]
    fn a_limit_is_earned_one_step_at_a_time() {
        let r = rules();
        assert_eq!(earned_limit(0, u128::MAX, &r), 0);
        assert_eq!(earned_limit(1, u128::MAX, &r), N);
        assert_eq!(earned_limit(4, u128::MAX, &r), 4 * N);
        assert_eq!(earned_limit(5, u128::MAX, &r), 5 * N);
        assert_eq!(earned_limit(50, u128::MAX, &r), 5 * N);
        assert_eq!(earned_limit(u32::MAX, u128::MAX, &r), 5 * N);
    }

    #[test]
    fn a_tiny_countersigned_payment_does_not_unlock_a_large_limit() {
        let r = rules();
        // One point from a 0.01 NEAR payment that a second steward approved.
        let dust = N / 100;
        assert_eq!(earned_limit(1, dust, &r), dust);
        // Any number of at-once payments later, the bound is still what a second person approved.
        assert_eq!(earned_limit(40, dust, &r), dust);
        // A second steward approving a real amount is what raises it.
        assert_eq!(earned_limit(3, 2 * N, &r), 2 * N);
        assert_eq!(earned_limit(3, 10 * N, &r), 3 * N);
        // Nobody has ever signed off on this account.
        assert_eq!(earned_limit(7, 0, &r), 0);
    }

    #[test]
    fn a_first_payment_always_needs_a_second_person() {
        let r = rules();
        assert_eq!(route(1, earned_limit(0, u128::MAX, &r), &r), Route::Countersign);
        assert_eq!(route(N, earned_limit(0, u128::MAX, &r), &r), Route::Countersign);
    }

    #[test]
    fn routes_follow_the_record_and_the_amount() {
        let r = rules();
        assert_eq!(route(N, earned_limit(1, u128::MAX, &r), &r), Route::Auto);
        assert_eq!(route(N + 1, earned_limit(1, u128::MAX, &r), &r), Route::Countersign);
        assert_eq!(route(10 * N, earned_limit(5, u128::MAX, &r), &r), Route::Countersign);
        assert_eq!(route(10 * N + 1, earned_limit(5, u128::MAX, &r), &r), Route::Council);
        assert_eq!(route(5 * N, earned_limit(9, u128::MAX, &r), &r), Route::Auto);
    }

    #[test]
    fn a_steward_cannot_open_more_than_the_caps() {
        let r = rules();
        let b = Budget { started_at: 100, committed: 0 };
        assert_eq!(commit(b, 200, 0, &r, false), Err("ERR_NO_REWARD"));
        assert_eq!(commit(b, 200, 21 * N, &r, false), Err("ERR_OVER_QUEST_CAP"));
        let b = commit(b, 200, 20 * N, &r, false).unwrap();
        let b = commit(b, 300, 20 * N, &r, false).unwrap();
        let b = commit(b, 400, 20 * N, &r, false).unwrap();
        assert_eq!(b.committed, 60 * N);
        assert_eq!(commit(b, 500, 1, &r, false), Err("ERR_OVER_PERIOD_CAP"));
    }

    #[test]
    fn the_dao_itself_can_open_any_quest() {
        let r = rules();
        let b = Budget { started_at: 100, committed: 60 * N };
        let b = commit(b, 200, 500 * N, &r, true).unwrap();
        assert_eq!(b.committed, 560 * N);
        // ... and that leaves nothing for stewards until the period rolls over.
        assert_eq!(commit(b, 300, N, &r, false), Err("ERR_OVER_PERIOD_CAP"));
    }

    #[test]
    fn a_new_period_starts_clean() {
        let r = rules();
        let b = Budget { started_at: 100, committed: 60 * N };
        let later = 100 + r.period_ns;
        let b = commit(b, later, 5 * N, &r, false).unwrap();
        assert_eq!(b, Budget { started_at: later, committed: 5 * N });
    }

    #[test]
    fn a_release_only_counts_inside_its_own_period() {
        let b = Budget { started_at: 100, committed: 10 * N };
        assert_eq!(release(b, 100, 4 * N).committed, 6 * N);
        assert_eq!(release(b, 50, 4 * N).committed, 10 * N);
        assert_eq!(release(b, 100, 40 * N).committed, 0);
    }

    const SETTLE: u64 = 20_000_000_000;

    #[test]
    fn approved_is_not_paid_until_the_transfer_had_time_to_run() {
        assert_eq!(after_check(Phase::Voted, Seen::Approved, 1_000, 1_000 + SETTLE - 1, SETTLE, true), Next::Stay);
        assert_eq!(after_check(Phase::Voted, Seen::Approved, 1_000, 1_000 + SETTLE, SETTLE, true), Next::Paid);
    }

    #[test]
    fn a_council_approval_is_noted_first_and_paid_on_a_later_look() {
        assert_eq!(after_check(Phase::Filed, Seen::Approved, 0, 5_000, SETTLE, true), Next::Clearing);
        assert_eq!(after_check(Phase::Clearing, Seen::Approved, 5_000, 5_000 + SETTLE / 2, SETTLE, true), Next::Stay);
        assert_eq!(after_check(Phase::Clearing, Seen::Approved, 5_000, 5_000 + SETTLE, SETTLE, true), Next::Paid);
    }

    #[test]
    fn a_failed_transfer_is_never_counted_as_paid() {
        for phase in [Phase::Filed, Phase::Voted, Phase::Clearing] {
            assert_eq!(after_check(phase, Seen::Failed, 0, u64::MAX, SETTLE, true), Next::Stay);
        }
    }

    #[test]
    fn refusals_end_the_payment_and_say_whether_the_budget_comes_back() {
        assert_eq!(after_check(Phase::Filed, Seen::Rejected, 0, 9, SETTLE, true), Next::Declined { refund_budget: true });
        assert_eq!(after_check(Phase::Voted, Seen::Expired, 0, 9, SETTLE, true), Next::Declined { refund_budget: true });
        assert_eq!(after_check(Phase::Filed, Seen::Removed, 0, 9, SETTLE, true), Next::Declined { refund_budget: false });
        assert_eq!(after_check(Phase::Filed, Seen::Missing, 0, 9, SETTLE, true), Next::Declined { refund_budget: false });
        assert_eq!(after_check(Phase::Clearing, Seen::Moved, 0, 9, SETTLE, true), Next::Declined { refund_budget: false });
    }

    #[test]
    fn an_expired_proposal_is_closed_so_the_bond_returns() {
        assert_eq!(after_check(Phase::Filed, Seen::InProgress { expired: true }, 0, 9, SETTLE, true), Next::Finalize);
        assert_eq!(after_check(Phase::Filed, Seen::InProgress { expired: false }, 0, 9, SETTLE, true), Next::Stay);
    }

    #[test]
    fn nothing_changes_while_a_call_is_in_flight_or_after_the_end() {
        for phase in [Phase::Pending, Phase::Filing, Phase::Voting, Phase::Paid, Phase::Declined] {
            for seen in [Seen::Approved, Seen::Rejected, Seen::Missing, Seen::Failed] {
                assert_eq!(after_check(phase, seen, 0, u64::MAX, SETTLE, true), Next::Stay);
            }
        }
    }

    const ME: &str = "grapevine.testnet";

    fn policy(extra_role: &str) -> String {
        format!(
            r#"{{
              "roles": [
                {{"name":"all","kind":"Everyone","permissions":["*:AddProposal"],"vote_policy":{{}}}},
                {{"name":"council","kind":{{"Group":["noor.testnet","tomas.testnet"]}},
                  "permissions":["*:AddProposal","*:VoteApprove","*:VoteReject","*:VoteRemove","*:Finalize"],"vote_policy":{{}}}}
                {extra_role}
              ],
              "default_vote_policy": {{"weight_kind":"RoleWeight","quorum":"0","threshold":[1,2]}},
              "proposal_bond": "10000000000000000000000",
              "proposal_period": "604800000000000",
              "bounty_bond": "10000000000000000000000",
              "bounty_forgiveness_period": "86400000000000"
            }}"#
        )
    }

    const GOOD_ROLE: &str = r#",{"name":"grapevine","kind":{"Group":["grapevine.testnet"]},
        "permissions":["transfer:AddProposal","transfer:VoteApprove","transfer:Finalize"],
        "vote_policy":{"transfer":{"weight_kind":"RoleWeight","quorum":"0","threshold":[1,1]}}}"#;

    #[test]
    fn a_policy_gives_the_stewards_the_bond_and_the_period() {
        let f = parse_policy(&policy(GOOD_ROLE), "council", ME).unwrap();
        assert_eq!(f.stewards, vec!["noor.testnet", "tomas.testnet"]);
        assert_eq!(f.bond, N / 100);
        assert_eq!(f.proposal_period_ns, 7 * DAY_NS);
        assert!(f.can_file && f.can_approve && f.can_finalize);
    }

    #[test]
    fn without_the_role_grapevine_can_file_but_not_approve() {
        let f = parse_policy(&policy(""), "council", ME).unwrap();
        assert!(f.can_file, "the Everyone role lets anyone file");
        assert!(!f.can_approve);
        assert!(!f.can_finalize);
    }

    #[test]
    fn a_role_whose_vote_rule_needs_more_than_one_vote_does_not_count() {
        let shared = r#",{"name":"grapevine","kind":{"Group":["grapevine.testnet","a.testnet","b.testnet"]},
            "permissions":["transfer:*"],
            "vote_policy":{"transfer":{"weight_kind":"RoleWeight","quorum":"0","threshold":[1,2]}}}"#;
        let f = parse_policy(&policy(shared), "council", ME).unwrap();
        assert!(!f.can_approve);
        assert!(f.can_finalize);

        let token_weighted = r#",{"name":"grapevine","kind":{"Group":["grapevine.testnet"]},
            "permissions":["transfer:VoteApprove"],
            "vote_policy":{"transfer":{"weight_kind":"TokenWeight","quorum":"0","threshold":"1"}}}"#;
        assert!(!parse_policy(&policy(token_weighted), "council", ME).unwrap().can_approve);
    }

    #[test]
    fn a_lone_member_passes_the_default_majority_rule() {
        let default_rule = r#",{"name":"grapevine","kind":{"Group":["grapevine.testnet"]},
            "permissions":["transfer:VoteApprove"],"vote_policy":{}}"#;
        assert!(parse_policy(&policy(default_rule), "council", ME).unwrap().can_approve);
    }

    #[test]
    fn an_unknown_steward_role_gives_no_stewards() {
        let f = parse_policy(&policy(GOOD_ROLE), "treasurers", ME).unwrap();
        assert!(f.stewards.is_empty());
    }

    #[test]
    fn a_broken_policy_is_refused() {
        assert_eq!(parse_policy("not json", "council", ME), Err("ERR_POLICY_NOT_JSON"));
        assert_eq!(parse_policy("{}", "council", ME), Err("ERR_POLICY_NO_ROLES"));
        assert_eq!(parse_policy(r#"{"roles":[]}"#, "council", ME), Err("ERR_POLICY_NO_BOND"));
    }

    fn proposal(status: &str, proposer: &str, receiver: &str, amount: &str, submitted: u64) -> String {
        format!(
            r#"[{{"id":7,"proposer":"{proposer}","description":"x",
                 "kind":{{"Transfer":{{"token_id":"","receiver_id":"{receiver}","amount":"{amount}","msg":null}}}},
                 "status":"{status}","vote_counts":{{}},"votes":{{}},"submission_time":"{submitted}"}}]"#
        )
    }

    #[test]
    fn a_proposal_read_reports_status_and_whether_it_is_ours() {
        let json = proposal("Approved", ME, "rosa.testnet", "2000", 100);
        let f = parse_proposal(&json, 7, ME, "rosa.testnet", 2_000, 200, 1_000).unwrap();
        assert_eq!(f, ProposalFacts { seen: Seen::Approved, ours: true, last_action_height: None });

        let other = parse_proposal(&json, 7, ME, "rosa.testnet", 2_001, 200, 1_000).unwrap();
        assert!(!other.ours, "a different amount is not our payment");
        let other = parse_proposal(&json, 7, ME, "eve.testnet", 2_000, 200, 1_000).unwrap();
        assert!(!other.ours, "a different receiver is not our payment");
        let other = parse_proposal(&json, 7, "someone.testnet", "rosa.testnet", 2_000, 200, 1_000).unwrap();
        assert!(!other.ours, "a proposal filed by someone else is not ours");
    }

    #[test]
    fn an_open_proposal_expires_after_the_period() {
        let json = proposal("InProgress", ME, "rosa.testnet", "5", 100);
        let early = parse_proposal(&json, 7, ME, "rosa.testnet", 5, 1_100, 1_000).unwrap();
        assert_eq!(early.seen, Seen::InProgress { expired: false });
        let late = parse_proposal(&json, 7, ME, "rosa.testnet", 5, 1_101, 1_000).unwrap();
        assert_eq!(late.seen, Seen::InProgress { expired: true });
    }

    #[test]
    fn an_empty_list_is_proof_of_removal_and_garbage_is_refused() {
        let f = parse_proposal("[]", 7, ME, "rosa.testnet", 5, 0, 1_000).unwrap();
        assert_eq!(f.seen, Seen::Missing);
        let other_id = proposal("Approved", ME, "rosa.testnet", "5", 0).replace("\"id\":7", "\"id\":8");
        assert_eq!(parse_proposal(&other_id, 7, ME, "rosa.testnet", 5, 0, 1_000).unwrap().seen, Seen::Missing);
        assert_eq!(parse_proposal("{}", 7, ME, "rosa.testnet", 5, 0, 1_000), Err("ERR_PROPOSAL_NOT_A_LIST"));
        assert_eq!(parse_proposal("", 7, ME, "rosa.testnet", 5, 0, 1_000), Err("ERR_PROPOSAL_NOT_JSON"));
        let odd = proposal("Sideways", ME, "rosa.testnet", "5", 0);
        assert_eq!(parse_proposal(&odd, 7, ME, "rosa.testnet", 5, 0, 1_000), Err("ERR_PROPOSAL_STATUS"));
    }

    #[test]
    fn a_token_transfer_is_not_mistaken_for_a_near_payment() {
        let json = proposal("Approved", ME, "rosa.testnet", "5", 0).replace("\"token_id\":\"\"", "\"token_id\":\"usdc.testnet\"");
        assert!(!parse_proposal(&json, 7, ME, "rosa.testnet", 5, 0, 1_000).unwrap().ours);
    }

    #[test]
    fn a_rerun_transfer_is_not_paid_until_its_action_is_old_enough() {
        // A council member finalizes a failed transfer directly on the DAO. For a couple of
        // blocks the proposal reads Approved again, while the re-run is still in flight.
        let json = proposal("Approved", ME, "rosa.testnet", "5", 0).replace(
            "\"submission_time\"",
            "\"last_actions_log\":[{\"block_height\":\"100\"},{\"block_height\":\"240\"}],\"submission_time\"",
        );
        let f = parse_proposal(&json, 7, ME, "rosa.testnet", 5, 0, 1_000).unwrap();
        assert_eq!(f.last_action_height, Some(240));
        assert!(!is_settled(f.last_action_height, 245, 12));
        assert!(is_settled(f.last_action_height, 252, 12));
        assert!(is_settled(None, 1, 12), "an older DAO reports no log");
        let fresh = after_check(Phase::Voted, Seen::Approved, 0, u64::MAX, SETTLE, is_settled(f.last_action_height, 245, 12));
        assert_eq!(fresh, Next::Stay);
        let later = after_check(Phase::Voted, Seen::Approved, 0, u64::MAX, SETTLE, is_settled(f.last_action_height, 252, 12));
        assert_eq!(later, Next::Paid);
    }

    #[test]
    fn an_earned_limit_is_an_allowance_for_the_period_not_per_payment() {
        let r = rules();
        let limit = earned_limit(2, u128::MAX, &r); // 2 NEAR
        let period = 500;
        // Nothing used yet: the whole limit is there.
        assert_eq!(auto_room(limit, 0, period, period), 2 * N);
        // One steward has already paid this account 1.5 NEAR at once in this period.
        let room = auto_room(limit, 3 * N / 2, period, period);
        assert_eq!(room, N / 2);
        assert_eq!(route(N / 2, room, &r), Route::Auto);
        assert_eq!(route(N / 2 + 1, room, &r), Route::Countersign, "over the allowance needs a second steward");
        // Used up, even over it: no room, never negative.
        assert_eq!(auto_room(limit, 5 * N, period, period), 0);
        // A new period starts clean.
        assert_eq!(auto_room(limit, 5 * N, period, period + 1), 2 * N);
    }

    #[test]
    fn text_cannot_forge_a_field_or_hide_itself() {
        assert_eq!(plain("x <br>* Notes: 1 NEAR to ops.near"), "x br Notes: 1 NEAR to ops.near");
        assert_eq!(plain("a\u{202E}b\u{200B}c\u{2028}d\u{FEFF}e"), "abcde");
        assert_eq!(plain("a\u{00AD}b\u{180E}c\u{FE0F}d\u{3164}e\u{E0041}f"), "abcdef");
        assert_eq!(plain("Find a sign-language interpreter (2 hours)"), "Find a sign-language interpreter (2 hours)");
    }

    #[test]
    fn a_hostile_threshold_cannot_overflow() {
        let huge = r#",{"name":"grapevine","kind":{"Group":["grapevine.testnet","b.testnet"]},
            "permissions":["transfer:VoteApprove"],
            "vote_policy":{"transfer":{"weight_kind":"RoleWeight","quorum":"0","threshold":[18446744073709551615,1]}}}"#;
        assert!(!parse_policy(&policy(huge), "council", ME).unwrap().can_approve);
    }

    #[test]
    fn amounts_read_like_a_person_would_write_them() {
        assert_eq!(fmt_near(0), "0");
        assert_eq!(fmt_near(1), "<0.0001");
        assert_eq!(fmt_near(N), "1");
        assert_eq!(fmt_near(5 * N / 2), "2.5");
        assert_eq!(fmt_near(N / 8), "0.125");
        assert_eq!(fmt_near(N / 3), "0.3333");
        assert_eq!(fmt_near(1234 * N + N / 100), "1234.01");
    }

    #[test]
    fn public_text_is_kept_on_one_line_and_short() {
        assert_eq!(one_line("  a\nb\tc  ", 20), "a b c");
        assert_eq!(one_line("abcdefghij", 5), "abcd…");
        assert_eq!(one_line("héllo wörld", 11), "héllo wörld");
    }
}
