// Deploys Grapevine, creates a demo community on the unmodified Sputnik DAO factory, and installs
// Grapevine through the DAO's own votes. Safe to re-run: every step checks whether it already happened.
//
//   node scripts/deploy.mjs <path-to-grapevine.wasm>
//
// Testnet only. Keys stay in the near-cli keychain (~/.near-credentials), never in this repository.
import fs from "node:fs";
import {
  NEAR,
  NETWORK,
  actions,
  b64,
  balanceOf,
  call,
  ensureSubaccount,
  exists,
  keepFloat,
  loadAccount,
  log,
  saveDeployment,
  send,
  sleep,
  teraToGas,
  toNear,
  trezuDescription,
  txUrl,
  view,
} from "./lib.mjs";

if (NETWORK !== "testnet") throw new Error("this script only deploys to testnet");

const HQ = process.env.GRAPEVINE_HQ || "grapevine-hq.testnet";
const CONTRACT = process.env.GRAPEVINE_CONTRACT || `v1.${HQ}`;
const FACTORY = "sputnikv2.testnet";
const DAO_NAME = process.env.GRAPEVINE_DAO_NAME || "riverside-coop";
const DAO = `${DAO_NAME}.${FACTORY}`;
const SITE = process.env.GRAPEVINE_SITE || "";
const TREASURY = process.env.GRAPEVINE_TREASURY || "4";
const person = (name) => `${name}.${HQ}`;

// The people in the demo. Stewards send the big calls, so they keep a larger gas float.
const council = ["noor", "tomas"].map(person);
const keeper = person("keeper");
const others = ["bea", "kofi", "rosa", "dev", "mallory", "sock"].map(person);
const SEVEN_DAYS_NS = "604800000000000";
const BOND = NEAR("0.01");

/** The rules the demo board runs on. Amounts are small because testnet NEAR is rationed. */
const BOARD_CONFIG = {
  steward_role: "council",
  doer_bps: 5000,
  relay_bps: 2500,
  max_hops: 5,
  min_cut: NEAR("0.01"),
  step: NEAR("0.25"),
  ceiling: NEAR("0.75"),
  countersign_cap: NEAR("1"),
  quest_cap: NEAR("2"),
  period_cap: NEAR("12"),
  period_ns: String(7 * 24 * 3600 * 1e9),
  announce: true,
  site: SITE,
};

const wasm = process.argv[2];
if (!wasm) throw new Error("usage: node scripts/deploy.mjs <path-to-grapevine.wasm>");

const deployment = {
  network: NETWORK,
  contract: CONTRACT,
  dao: DAO,
  factory: FACTORY,
  hq: HQ,
  site: SITE,
  social: "social",
  people: { council, keeper, others },
  proposals: {},
  txs: {},
};
const remember = (key, hash) => {
  deployment.txs[key] = hash;
  log(`  ${key}: ${txUrl(hash)}`);
};
const must = (res, what) => {
  if (!res.ok) throw new Error(`${what}: ${res.failures.join("; ")}`);
  return res;
};

const hq = loadAccount(HQ);
log(`HQ ${HQ} holds ${toNear(await balanceOf(HQ))} NEAR`);

// 1. The accounts. Each is a named sub-account, so every record on the board reads as a name.
for (const id of [...council, keeper]) await ensureSubaccount(hq, id, "0.6");
for (const id of others) await ensureSubaccount(hq, id, "0.15");

// 2. The contract.
const code = fs.readFileSync(wasm);
if (!(await exists(CONTRACT))) {
  // Every 100 KB of code locks 1 NEAR.
  const needed = (code.length / 100_000 + 0.35).toFixed(2);
  log(`creating ${CONTRACT} with ${needed} NEAR for ${code.length} bytes of code`);
  await ensureSubaccount(hq, CONTRACT, needed);
}
const contractAccount = loadAccount(CONTRACT);
const version = await view(CONTRACT, "version").catch(() => null);
if (version === null) {
  const res = await send(contractAccount, CONTRACT, [
    actions.deployContract(code),
    // Deploy and initialise in one transaction, binding this copy to the one DAO it will serve.
    actions.functionCall("new", { dao: DAO, social: "social" }, teraToGas(30), 0n),
  ]);
  must(res, "deploy");
  remember("deploy", res.hash);
} else if (process.env.GRAPEVINE_REDEPLOY) {
  const res = await send(contractAccount, CONTRACT, [actions.deployContract(code)]);
  must(res, "redeploy");
  remember("redeploy", res.hash);
} else {
  log(`  contract already deployed, version ${version}`);
}

// 3. The community's DAO, on the unmodified Sputnik factory.
const policy = {
  roles: [
    {
      name: "council",
      kind: { Group: council },
      permissions: ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
      vote_policy: {},
    },
    { name: "all", kind: "Everyone", permissions: ["transfer:AddProposal"], vote_policy: {} },
  ],
  default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
  proposal_bond: BOND,
  proposal_period: SEVEN_DAYS_NS,
  bounty_bond: BOND,
  bounty_forgiveness_period: "86400000000000",
};
if (!(await exists(DAO))) {
  const args = {
    config: { name: DAO_NAME, purpose: "Riverside Food Co-op: a neighbourhood food co-op run by its members", metadata: "" },
    policy,
  };
  const res = await call(hq, FACTORY, "create", { name: DAO_NAME, args: b64(args) }, { gas: 300, deposit: NEAR("5.55") });
  must(res, "create DAO");
  remember("create_dao", res.hash);
}

// 4. Give the treasury something to pay with. It also has to keep covering the DAO's own storage.
{
  const target = BigInt(NEAR(TREASURY)) + BigInt(NEAR("5.5"));
  const held = BigInt(await balanceOf(DAO));
  if (held < target) {
    const free = BigInt(await balanceOf(HQ)) - BigInt(NEAR("1.2"));
    const amount = target - held < free ? target - held : free;
    if (amount > 0n) {
      const res = await send(hq, DAO, [actions.transfer(amount)]);
      must(res, "fund treasury");
      remember("fund_treasury", res.hash);
    }
  }
}

// 5. Install: two ordinary proposals, passed by the council's own votes.
for (const id of [...council, keeper]) await keepFloat(hq, id, "0.55");

const propose = async (description, kind) => {
  const last = await view(DAO, "get_last_proposal_id");
  const recent = await view(DAO, "get_proposals", { from_index: Math.max(0, last - 20), limit: 20 });
  const open = recent.find((p) => p.description === description && p.status === "InProgress");
  if (open) return open.id;
  const res = await call(loadAccount(council[0]), DAO, "add_proposal", { proposal: { description, kind } }, { gas: 50, deposit: BOND });
  must(res, "add_proposal");
  remember(`propose_${res.value}`, res.hash);
  return res.value;
};
const passByCouncil = async (id, kind, label) => {
  for (const name of council) {
    const { votes, status } = await view(DAO, "get_proposal", { id });
    if (status !== "InProgress" || votes[name]) continue;
    const res = await call(loadAccount(name), DAO, "act_proposal", { id, action: "VoteApprove", proposal: kind }, { gas: 270 });
    must(res, `vote on ${label}`);
    remember(`${label}_vote_${name.split(".")[0]}`, res.hash);
  }
  const { status } = await view(DAO, "get_proposal", { id });
  if (status !== "Approved") throw new Error(`${label} ended as ${status}`);
};

const ROLE = {
  name: "grapevine",
  kind: { Group: [CONTRACT] },
  permissions: ["transfer:AddProposal", "transfer:VoteApprove", "transfer:Finalize"],
  vote_policy: { transfer: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 1] } },
};

const currentPolicy = await view(DAO, "get_policy");
if (!currentPolicy.roles.some((r) => r.name === ROLE.name)) {
  const kind = { ChangePolicyAddOrUpdateRole: { role: ROLE } };
  const id = await propose(
    trezuDescription(
      "Install Grapevine",
      "Adds one role that holds only transfer permissions. It lets the Grapevine contract file a quest's payments and approve the ones inside the limits this DAO sets.",
    ),
    kind,
  );
  deployment.proposals.role = id;
  await passByCouncil(id, kind, "install_role");
}

if ((await view(CONTRACT, "get_board", { dao: DAO })) === null) {
  const kind = {
    FunctionCall: {
      receiver_id: CONTRACT,
      actions: [
        {
          method_name: "create_board",
          args: b64({ config: BOARD_CONFIG }),
          deposit: NEAR("0.3"),
          gas: "100000000000000",
        },
      ],
    },
  };
  const id = await propose(
    trezuDescription(
      "Open a Grapevine board",
      "Sets the quest caps, the split and the earned limits. The 0.3 NEAR is a float for proposal bonds and storage, never reward money.",
    ),
    kind,
  );
  deployment.proposals.board = id;
  await passByCouncil(id, kind, "create_board");
  await sleep(3000);
}

// 6. Check the install from the contract's own point of view.
let board = await view(CONTRACT, "get_board", { dao: DAO });
if (!board.can_approve) {
  must(await call(loadAccount(keeper), CONTRACT, "sync", { dao: DAO }, { gas: 100 }), "sync");
  board = await view(CONTRACT, "get_board", { dao: DAO });
}
if (!(board.can_file && board.can_approve && board.can_finalize)) {
  throw new Error(`the board is not fully installed: ${JSON.stringify({ file: board.can_file, approve: board.can_approve, finalize: board.can_finalize })}`);
}
log(`board installed. Stewards: ${board.stewards.join(", ")}. Float ${toNear(board.float)} NEAR. Bond ${toNear(board.bond)} NEAR.`);

const previous = fs.existsSync(new URL(`../deployments/${NETWORK}.json`, import.meta.url))
  ? JSON.parse(fs.readFileSync(new URL(`../deployments/${NETWORK}.json`, import.meta.url), "utf8"))
  : {};
saveDeployment({
  ...previous,
  ...deployment,
  proposals: { ...previous.proposals, ...deployment.proposals },
  txs: { ...previous.txs, ...deployment.txs },
});
// The static site reads this file. The demo server answers the same path with the demo switched on.
fs.writeFileSync(
  new URL("../web/config.json", import.meta.url),
  JSON.stringify({ network: NETWORK, deployed: true, contract: CONTRACT, dao: DAO, hq: HQ, site: SITE, demo: false, personas: [] }, null, 2) + String.fromCharCode(10),
);
log(`treasury ${DAO} holds ${toNear(await balanceOf(DAO))} NEAR; HQ has ${toNear(await balanceOf(HQ))} NEAR left`);
