// Writing to near.social from a script: one function call to the account `social`.
//
// The receiving account has no contract (and on testnet does not even exist), so the transaction
// always reports a failure. That is how FastData works: the indexer reads the call's arguments
// and ignores its outcome. Never retry because of that failure; confirm through a read instead.
import { NETWORK, actions, sleep } from "./lib.mjs";
import { SOCIAL_ACCOUNT, makeSocial } from "../web/social.js";

export * from "../web/social.js";

export const social = makeSocial(NETWORK);

/** Send one `__fastdata_kv` write. Returns the transaction hash. */
export async function writeSocial(account, args) {
  const res = await account.signAndSendTransaction({
    receiverId: SOCIAL_ACCOUNT,
    // Gas 1: the call does no work, and a function-call key is billed for the gas it attaches.
    actions: [actions.functionCall("__fastdata_kv", args, 1n, 0n)],
    waitUntil: "INCLUDED_FINAL",
    throwOnFailure: false,
  });
  return res.transaction.hash;
}

/** Wait until FastData serves the given keys for an account. Returns true when all are there. */
export async function waitForKeys(accountId, keys, timeoutMs = 45_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const found = await social.multi(keys.map((k) => [accountId, k])).catch(() => new Map());
    if (keys.every((k) => found.has(`${accountId}/${k}`))) return true;
    await sleep(1500);
  }
  return false;
}

/** On mainnet, near.social's own indexer reports what it did with a transaction. */
export async function indexerReport(hash) {
  if (NETWORK !== "mainnet") return null;
  const res = await fetch(`https://api2.near.social/v1/tx/${hash}`);
  return res.ok ? res.json() : null;
}
