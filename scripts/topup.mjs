// Tops an existing testnet account up from the community faucet behind near-faucet.io, by
// calling its contract directly as that account. The faucet gives 2 test NEAR per receiver
// about once an hour, so this asks, waits, and asks again until the account holds enough.
//
//   node scripts/topup.mjs <account>.testnet <NEAR wanted in total>
import { NEAR, balanceOf, call, loadAccount, log, sleep, toNear } from "./lib.mjs";

const FAUCET = "v2.faucet.nonofficial.testnet";
const account = process.argv[2];
const want = BigInt(NEAR(process.argv[3] ?? "17"));
if (!account) throw new Error("usage: node scripts/topup.mjs <account>.testnet <NEAR wanted in total>");

const me = loadAccount(account);
for (let round = 0; round < 40; round++) {
  const have = BigInt(await balanceOf(account));
  if (have >= want) {
    log(`${account} holds ${toNear(have)} NEAR: enough`);
    break;
  }
  const res = await call(me, FAUCET, "request_near", { request_amount: NEAR("2"), receiver_id: account }, { gas: 50 });
  const now = BigInt(await balanceOf(account));
  log(res.ok ? `the faucet sent ${toNear(now - have)} NEAR; ${account} holds ${toNear(now)}` : `the faucet refused: ${res.failures.join("; ").slice(0, 160)}`);
  if (now >= want) break;
  // A refusal usually means "too soon". Either way the next request is worth making in a while.
  await sleep(res.ok ? 61 * 60_000 : 20 * 60_000);
}
