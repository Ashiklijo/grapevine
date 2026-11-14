// Shared helpers for the deploy, demo and test scripts.
// Keys are read from ~/.near-credentials (the near-cli keychain), never from this repository.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Account,
  FailoverRpcProvider,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
  teraToGas,
} from "near-api-js";
import { SOCIAL_ACCOUNT } from "../web/social.js";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const NETWORK = process.env.NEAR_NETWORK || "testnet";

export const RPCS = {
  testnet: ["https://near-testnet.drpc.org", "https://rpc.testnet.fastnear.com", "https://test.rpc.fastnear.com"],
  mainnet: ["https://free.rpc.fastnear.com", "https://near.drpc.org", "https://rpc.mainnet.near.org"],
};

/** FastData KV, the public store behind near.social. Same API on both networks. */
export const KV = {
  testnet: "https://kv.test.fastnear.com",
  mainnet: "https://kv.main.fastnear.com",
}[NETWORK];

export const EXPLORER = {
  testnet: "https://testnet.nearblocks.io",
  mainnet: "https://nearblocks.io",
}[NETWORK];

export const provider = new FailoverRpcProvider(RPCS[NETWORK].map((url) => new JsonRpcProvider({ url })));

const CRED_DIR = path.join(os.homedir(), ".near-credentials", NETWORK);

/** "1.5" -> yoctoNEAR as a decimal string. */
export const NEAR = (amount) => {
  const [whole, frac = ""] = String(amount).split(".");
  return BigInt(whole + frac.padEnd(24, "0").slice(0, 24)).toString();
};
/** yoctoNEAR -> "1.5" with up to `digits` decimals, trailing zeros removed. */
export const toNear = (yocto, digits = 4) => {
  const v = BigInt(yocto);
  const unit = 10n ** BigInt(24 - digits);
  const scaled = (v + unit / 2n) / unit;
  const whole = scaled / 10n ** BigInt(digits);
  const frac = (scaled % 10n ** BigInt(digits)).toString().padStart(digits, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);

export function deployment() {
  const file = path.join(ROOT, "deployments", `${NETWORK}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployments/${NETWORK}.json yet: run scripts/deploy.mjs first`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function saveDeployment(data) {
  const file = path.join(ROOT, "deployments", `${NETWORK}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export function hasKey(accountId) {
  return fs.existsSync(path.join(CRED_DIR, `${accountId}.json`));
}

export function readKey(accountId) {
  const file = path.join(CRED_DIR, `${accountId}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function loadAccount(accountId) {
  const { private_key: privateKey } = readKey(accountId);
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(privateKey));
}

export function saveKey(accountId, keyPair) {
  fs.mkdirSync(CRED_DIR, { recursive: true });
  const file = path.join(CRED_DIR, `${accountId}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ account_id: accountId, public_key: keyPair.getPublicKey().toString(), private_key: keyPair.toString() }),
    { mode: 0o600 },
  );
}

async function rpc(method, params) {
  let lastError;
  for (const url of RPCS[NETWORK]) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "grapevine", method, params }),
      });
      if (!res.ok) {
        lastError = new Error(`${url} answered ${res.status}`);
        continue;
      }
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("no RPC endpoint answered");
}

/** The account's balance in yoctoNEAR, or null when the account does not exist. */
export async function balanceOrNull(accountId) {
  const body = await rpc("query", { request_type: "view_account", finality: "final", account_id: accountId });
  if (body.result) return BigInt(body.result.amount);
  if (body.error?.cause?.name === "UNKNOWN_ACCOUNT") return null;
  throw new Error(`could not read ${accountId}: ${JSON.stringify(body.error)}`);
}

export const exists = async (accountId) => (await balanceOrNull(accountId)) !== null;

export const balanceOf = async (accountId) => {
  const amount = await balanceOrNull(accountId);
  if (amount === null) throw new Error(`${accountId} does not exist`);
  return amount.toString();
};

/** A read-only contract call. */
export async function view(contractId, method, args = {}) {
  const body = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (body.error || body.result?.error) {
    throw new Error(`view ${contractId}.${method} failed: ${JSON.stringify(body.error ?? body.result.error)}`);
  }
  const text = Buffer.from(body.result.result).toString();
  return text.length ? JSON.parse(text) : null;
}

function failureOf(status) {
  return status && typeof status === "object" && status.Failure ? JSON.stringify(status.Failure) : null;
}

/** The contract's own panic message when there is one, otherwise the raw failure. */
export function readableError(raw) {
  const match = raw.match(/Smart contract panicked: ([^"\\]+)/);
  return match ? match[1].trim() : raw;
}

/**
 * Send a transaction, wait for every receipt, and report what really happened.
 *
 * A near.social post is a function call to SOCIAL_ACCOUNT, and the receipt that carries it always
 * fails by design: on mainnet the account has no contract (CodeDoesNotExist), on testnet there is
 * no such account (AccountDoesNotExist). FastData indexes the call either way. So a failed receipt
 * executed by that account is a post, not a failure, and is not counted.
 */
export async function send(account, receiverId, txActions) {
  const res = await account.signAndSendTransaction({
    receiverId,
    actions: txActions,
    waitUntil: "FINAL",
    throwOnFailure: false,
  });
  const hash = res.transaction.hash;
  const outcomes = [res.transaction_outcome, ...res.receipts_outcome];
  const logs = outcomes.flatMap((o) => o.outcome.logs);
  const failures = outcomes
    .filter((o) => o.outcome.executor_id !== SOCIAL_ACCOUNT)
    .map((o) => failureOf(o.outcome.status))
    .filter(Boolean)
    .map(readableError);
  const success = res.status?.SuccessValue;
  let value;
  if (typeof success === "string" && success.length) {
    try {
      value = JSON.parse(Buffer.from(success, "base64").toString());
    } catch {
      value = undefined;
    }
  }
  const events = logs
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice("EVENT_JSON:".length)));
  const gasBurnt = outcomes.reduce((sum, o) => sum + BigInt(o.outcome.gas_burnt), 0n);
  return { hash, ok: failures.length === 0, failures, logs, events, value, gasBurnt };
}

export function call(account, contractId, method, args = {}, { gas = 300, deposit = "0" } = {}) {
  return send(account, contractId, [actions.functionCall(method, args, teraToGas(gas), BigInt(deposit))]);
}

/** Like `call`, but throws when any receipt failed. */
export async function mustCall(account, contractId, method, args = {}, options = {}) {
  const res = await call(account, contractId, method, args, options);
  if (!res.ok) throw new Error(`${contractId}.${method} failed: ${res.failures.join("; ")}`);
  return res;
}

/**
 * Delete `accountId` and send what it holds to `beneficiary`. Judged by the chain, not by the
 * answer: when an RPC node retries a deletion that already went through, it answers "signer does
 * not exist", and a node that has not seen a new account yet answers the same. So a few tries,
 * and the account being gone is what counts.
 */
export async function deleteInto(accountId, beneficiary, tries = 4) {
  const gone = async () => (await balanceOrNull(accountId).catch(() => 0n)) === null;
  let why = "";
  for (let i = 0; i < tries && !(await gone()); i++) {
    try {
      const res = await send(loadAccount(accountId), accountId, [actions.deleteAccount(beneficiary)]);
      if (!res.ok) why = res.failures.join("; ");
    } catch (err) {
      why = err.message.split("\n")[0];
    }
    await sleep(3000);
  }
  return (await gone()) ? { ok: true } : { ok: false, why };
}

/** Create `accountId` (a sub-account of `parent`) with `near` NEAR, and keep its key in the keychain. */
export async function ensureSubaccount(parent, accountId, near) {
  if (await exists(accountId)) return false;
  const keyPair = KeyPair.fromRandom("ed25519");
  const res = await send(parent, accountId, [
    actions.createAccount(),
    actions.transfer(BigInt(NEAR(near))),
    actions.addFullAccessKey(keyPair.getPublicKey()),
  ]);
  if (!res.ok) throw new Error(`could not create ${accountId}: ${res.failures.join("; ")}`);
  saveKey(accountId, keyPair);
  return true;
}

/** A transaction reserves its gas up front, so every signer needs a small float. */
export async function keepFloat(funder, accountId, near) {
  const have = BigInt(await balanceOf(accountId));
  const want = BigInt(NEAR(near));
  if (have >= want) return false;
  const res = await send(funder, accountId, [actions.transfer(want - have)]);
  if (!res.ok) throw new Error(`could not fund ${accountId}: ${res.failures.join("; ")}`);
  return true;
}

/**
 * Top up the demo accounts from the project's own account. A call reserves its gas up front
 * (about 0.3 NEAR for the largest ones), and stewards also pay a little storage for each quest.
 */
export async function keepFloats(d, { stewards = "0.6", others = "0.15" } = {}) {
  const funder = loadAccount(d.hq);
  for (const id of [...d.people.council, d.people.keeper]) await keepFloat(funder, id, stewards);
  for (const id of d.people.others) await keepFloat(funder, id, others);
}

export const txUrl = (hash) => `${EXPLORER}/txns/${hash}`;
export const accountUrl = (id) => `${EXPLORER}/address/${id}`;

/** base64 of a JSON value, the form Sputnik wants for FunctionCall args. */
export const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64");

/** The description format Trezu parses for a request: "* Title: ... <br>* Notes: ...". */
export const trezuDescription = (title, notes) => `* Title: ${title} <br>* Notes: ${notes}`;

/** File a proposal on a Sputnik DAO. Returns its id. */
export async function propose(account, dao, description, kind) {
  const policy = await view(dao, "get_policy");
  const res = await mustCall(account, dao, "add_proposal", { proposal: { description, kind } }, { gas: 60, deposit: policy.proposal_bond });
  return { id: res.value, hash: res.hash };
}

/** Cast one vote on a Sputnik proposal. */
export async function vote(account, dao, id, action = "VoteApprove") {
  const proposal = await view(dao, "get_proposal", { id });
  return mustCall(account, dao, "act_proposal", { id, action, proposal: proposal.kind }, { gas: 200 });
}

export { Account, KeyPair, KeyPairSigner, actions, teraToGas };
