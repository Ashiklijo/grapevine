// Creates the project's own top-level testnet account, in whichever way comes first:
//
//   - test NEAR arrives at the key's implicit address (printed below), and this script
//     spends it on creating the named account through the `testnet` registrar;
//   - the public faucet's rate limit resets, and the faucet creates the account.
//
// The faucet gives a new account 10 test NEAR. A Sputnik DAO and a contract cost more than that,
// so with `--extra 1` the script also asks the faucet for one more account straight away and
// folds it into the first: the extra account is deleted and its balance goes to the main one.
//
// The key must already be in the near-cli keychain (near-cli writes it even when the faucet
// refuses). Nothing here touches mainnet.
//
//   node scripts/bootstrap.mjs [account.testnet] [--extra 1]
import {
  Account,
  KeyPair,
  KeyPairSigner,
  NEAR,
  actions,
  balanceOrNull,
  deleteInto,
  hasKey,
  loadAccount,
  log,
  provider,
  readKey,
  saveKey,
  send,
  sleep,
  teraToGas,
  toNear,
} from "./lib.mjs";

const HELPER = "https://helper.nearprotocol.com/account";
const args = process.argv.slice(2);
const ACCOUNT = args.find((a) => a.endsWith(".testnet")) ?? "grapevine-hq.testnet";
const EXTRA = args.includes("--extra") ? Number(args[args.indexOf("--extra") + 1]) : 0;
const CHECK_EVERY_MS = 45_000;

const { private_key: secret, public_key: publicKey } = readKey(ACCOUNT);
const implicit = Buffer.from(KeyPair.fromString(secret).getPublicKey().data).toString("hex");
log(`waiting to create ${ACCOUNT}`);
log(`send test NEAR to this implicit address to create it now: ${implicit}`);

/** Ask the faucet to create an account. Returns "created", or the seconds to wait before asking again. */
async function askFaucet(accountId, key) {
  try {
    const res = await fetch(HELPER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: key }),
    });
    if (res.ok) return "created";
    if (res.status === 429) return Number(res.headers.get("retry-after") ?? 1800);
    log(`the faucet answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return 600;
  } catch (err) {
    log(`the faucet could not be reached: ${err.message}`);
    return 300;
  }
}

async function waitFor(accountId, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const balance = await balanceOrNull(accountId).catch(() => null);
    if (balance !== null) return balance;
    await sleep(3000);
  }
  return null;
}

/** Spend the implicit address's balance on creating the named account. */
async function createFromImplicit(balance) {
  const deposit = balance - BigInt(NEAR("0.05"));
  const signer = new Account(implicit, provider, KeyPairSigner.fromSecretKey(secret));
  const res = await send(signer, "testnet", [
    actions.functionCall("create_account", { new_account_id: ACCOUNT, new_public_key: publicKey }, teraToGas(100), deposit),
  ]);
  log(res.ok ? `created from the implicit address: ${res.hash}` : `creation failed: ${res.failures.join("; ")}`);
}

let helperAllowedAt = 0;
let byFaucet = false;

for (;;) {
  const named = await balanceOrNull(ACCOUNT).catch(() => undefined);
  if (named !== null && named !== undefined) {
    log(`${ACCOUNT} exists with ${toNear(named)} NEAR`);
    break;
  }
  const funded = await balanceOrNull(implicit).catch(() => null);
  if (funded !== null && funded >= BigInt(NEAR("0.2"))) {
    log(`the implicit address holds ${toNear(funded)} NEAR; creating the named account from it`);
    await createFromImplicit(funded).catch((err) => log(`creation attempt failed: ${err.message}`));
    await sleep(4000);
    continue;
  }
  if (Date.now() >= helperAllowedAt) {
    const answer = await askFaucet(ACCOUNT, publicKey);
    if (answer === "created") {
      log("the faucet accepted the request");
      byFaucet = true;
      await waitFor(ACCOUNT);
      continue;
    }
    helperAllowedAt = Date.now() + (answer + 15) * 1000;
    log(`the faucet will not create an account for another ${Math.round(answer / 60)} minutes`);
  }
  await sleep(Math.min(CHECK_EVERY_MS, Math.max(5000, helperAllowedAt - Date.now())));
}

// One faucet account does not cover a DAO and a contract. Ask for the extra ones right away,
// while the faucet's allowance is fresh, and fold each into the main account.
for (let i = 1; byFaucet && i <= EXTRA; i++) {
  const extra = `${ACCOUNT.replace(/\.testnet$/, "")}-f${i}.testnet`;
  if (!hasKey(extra)) saveKey(extra, KeyPair.fromRandom("ed25519"));
  if ((await balanceOrNull(extra).catch(() => null)) === null) {
    const answer = await askFaucet(extra, readKey(extra).public_key);
    if (answer !== "created") {
      log(`no extra account: the faucet says wait ${Math.round(answer / 60)} minutes`);
      break;
    }
  }
  const balance = await waitFor(extra);
  if (balance === null) {
    log(`${extra} did not appear`);
    break;
  }
  const folded = await deleteInto(extra, ACCOUNT, 6);
  log(folded.ok ? `folded ${extra} (${toNear(balance)} NEAR) into ${ACCOUNT}` : `could not fold ${extra} (${folded.why}); fold it by hand: near account delete-account ${extra} beneficiary ${ACCOUNT}`);
}
log(`${ACCOUNT} holds ${toNear((await balanceOrNull(ACCOUNT)) ?? 0n)} NEAR`);
