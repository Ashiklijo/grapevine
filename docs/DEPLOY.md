# Deploy your own copy on testnet

This creates a Sputnik DAO you control, installs Grapevine on it through the DAO's own votes, and runs every path. Testnet only. Nothing here touches mainnet.

## What you need

- Node 20 or later, and `npm ci` run once in the repository.
- Rust with the `wasm32-unknown-unknown` target, and optionally [cargo-near](https://github.com/near/cargo-near).
- [near-cli-rs](https://github.com/near/near-cli-rs), to create the first account.
- About 17 test NEAR with the default 4 NEAR treasury. The faucet gives 10 per new account, so make two accounts and fold one into the other: `node scripts/bootstrap.mjs <name>-hq.testnet --extra 1` does both.

| Cost | Test NEAR |
|---|---|
| The contract's account (1 NEAR per 100 KB of code) | 3.4 |
| The DAO, made by the `sputnikv2.testnet` factory | 5.55 |
| Gas floats for the demo accounts, plus 0.7 when the live checks top up the two outsiders | 2.7 |
| The treasury, for rewards (`GRAPEVINE_TREASURY`, 4 by default) | 4 |
| The board's float, for proposal bonds and what callbacks store | 0.3 |

## Steps

**1. Make the account everything else hangs from.**

```bash
near account create-account sponsor-by-faucet-service <name>-hq.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
```

See: the account exists, and its key is in `~/.near-credentials/testnet/`.

If the faucet answers `429`, it has hit its limit of ten accounts per address in twelve hours. `node scripts/bootstrap.mjs <name>-hq.testnet` prints an implicit address and waits: it creates the account as soon as test NEAR arrives there, or when the faucet's limit resets.

**2. Build the contract.**

```bash
cd contract && cargo near build non-reproducible-wasm --no-abi
```

See: the path and size of `grapevine.wasm`.

**3. Deploy and install.**

```bash
GRAPEVINE_HQ=<name>-hq.testnet GRAPEVINE_DAO_NAME=<your-dao-name> node scripts/deploy.mjs <path to grapevine.wasm>
```

See, in order: the demo accounts created as sub-accounts; the contract deployed; the DAO created on the unmodified factory; the treasury funded; a `ChangePolicyAddOrUpdateRole` proposal passed by two council votes; a `FunctionCall` proposal calling `create_board` passed the same way; and the line `board installed`. The addresses are written to `deployments/testnet.json` and `web/config.json`.

The script is safe to re-run. Each step checks whether it already happened.

**4. Give the demo community a past.**

```bash
node scripts/seed.mjs
```

See: near.social profiles and follows written to testnet's FastData, and one finished quest with two paid payments.

**5. Run every path.**

```bash
node scripts/e2e.mjs
```

See: each check printed as `PASS` with its transaction, ending in `N of N checks passed`. The report is written to `deployments/testnet-e2e.json`. `--quick` skips the council-vote scenario, which moves the most test NEAR.

**6. Use it.**

```bash
node scripts/serve.mjs --demo
```

Open <http://127.0.0.1:4180>. Pick a person in the top right corner and act as them. Every button sends a real transaction signed with that demo account's key from your keychain. The server listens on `127.0.0.1` only and signs only for the accounts named in `deployments/testnet.json`.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `GRAPEVINE_HQ` | `grapevine-hq.testnet` | The account that pays for everything and parents the others |
| `GRAPEVINE_CONTRACT` | `v1.<hq>` | Where the contract is deployed |
| `GRAPEVINE_DAO_NAME` | `riverside-coop` | The DAO becomes `<name>.sputnikv2.testnet` |
| `GRAPEVINE_TREASURY` | `4` | Test NEAR to put in the treasury for rewards |
| `GRAPEVINE_SITE` | empty | The public address of the site, used in posts that link to a quest |
| `GRAPEVINE_REDEPLOY` | unset | Set to push new code to an existing contract account |

## Installing on an existing DAO

One copy of the contract serves one DAO. So first deploy a copy for yours, and initialise it in the same transaction:

```bash
near contract deploy <copy>.testnet use-file <path to grapevine.wasm> with-init-call new json-args '{"dao":"<your dao>","social":"social"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
```

See: the account holds the code, and `dao` answers with your DAO. Only that DAO can open a board on it.

The Install page of the site (`#install`) then shows the two proposals as JSON. File them in any Sputnik interface or with near-cli. On Trezu, both show as ordinary requests. `create_board` reads the council and the bond from the DAO's policy. After the council changes, anyone calls `sync {"dao": "<your dao>"}`.

## Mainnet

Not done, and not to be done with this version: the contract is unaudited and its account keeps a deploy key. The code has no testnet-only parts. `NEAR_NETWORK=mainnet` points the scripts at mainnet RPC and at mainnet's FastData, where the account `social` is near.social itself.
