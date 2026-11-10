# INTENT-VAULT - non-custodial cross-chain NEAR Intents solver swap and ERC-4626-style agent earnings vault

## 1. Problem Solved
Trading and service agents earning across multiple chains need a non-custodial way to quote and settle cross-chain swaps via NEAR Intents and park idle USDC earnings into a yield-accruing share vault without custodian risk.

## Prerequisites
- **Node.js 20 or later** (tested on Node v24.22.1). No other dependencies: the demo and tests use only the Node.js standard library (`node:crypto`, `node:test`, `node:assert`, `node:fs`).
- For the testnet deploy only: `npm install` (pulls `near-api-js` for the deploy script and `near-sdk-js` for the contract build).

## 2. Try It ('Do X -> See Y' Deterministic Steps)
```bash
npm test
node scripts/demo.mjs
bash docs/verify.sh
```
1. **`quote`**: Solver quotes cross-chain intent swap of 5,000 Base USDC (`eip155:8453`) -> NEAR USDC (`near:mainnet`) at 0.9992 rate (4,996.00 NEAR USDC, 4.00 USDC solver fee, 300s deadline, signed intent hash verified)
2. **`swap`**: executeIntentSwap() verifies solver + user commitments and settles atomically -> agent NEAR balance = 4,996.00 USDC, solver balance +4.00 USDC, replay of same intent nonce -> REFUSED (intent_already_settled)
3. **`deposit_and_withdraw`**: Agent deposits 4,000.00 USDC into EarningsVault -> receives 4,000.0000 vUSDC shares; after 120.00 USDC protocol revenue accrues to the vault (share price = 1.0300 USDC), agent redeems 2,000.0000 shares -> receives 2,060.00 USDC exactly

Every number above is **computed, not pasted**: `src/engine.mjs` runs the scenario in integer micro-USDC (BigInt), and `test/engine.test.mjs` asserts the invariants — swap-out = amount x (1 - fee), share price = assets / shares recomputed from vault state, redeem = shares x price, replay refused, intent hash = sha256 of the canonical intent JSON. Tamper with any input or the fee rate and the tests fail.

Final Merkle State Head: `bac5a06ba1dd20e13cac3df5b16832d8e03b25bd4435e36a2d4c525fd7f217d4`

![Demo running](docs/demo-screenshot.png)
*Real terminal capture of `node scripts/demo.mjs` (rendered by `scripts/render-screenshot.py` from live stdout).*

![Architecture](docs/architecture.svg)
*Quote → intent → solver → vault. See `docs/architecture.svg`.*

## 3. Mechanical Mapping to NEAR Protocol Contracts
Maps 1:1 to NEAR Intents (`intents.near` `execute_intents` multi-token diff verification) paired with a NEP-141 share-accounting vault contract (`deposit` / `withdraw` with virtual share offset preventing inflation attacks).

Links:
- NEAR Intents docs: https://docs.near.org/chain-abstraction/intents/overview and https://docs.near-intents.org/getting-started/what-are-intents
- NEP-141 (Fungible Token Standard): https://github.com/near/NEPs/blob/master/neps/nep-0141.md and https://nomicon.io/Standards/Tokens/FungibleToken

## 4. On-Chain Evidence (NEAR testnet, 2026-11-09)
The same flow was executed against a minimal vault contract deployed to NEAR testnet. Contract: [`ivault-backstop-1109.testnet`](https://explorer.testnet.near.org/accounts/ivault-backstop-1109.testnet) (WASM sha256 `bbafc35fd0d8c4b1f598a2bd62997044274c09ebf7a9a12606ae69fb85d56960`).

Intent hash: `6bb60a048b4789e086d18f30ab7a86b56b99e2d5c89a2011f69b9cbc2b0bcb96`

| Step | Tx hash | Explorer |
|---|---|---|
| Deploy | `CDcHeCo4or7kPUXKKvkiVs3ZxQ8khpC9YAddn2LrnsDm` | https://explorer.testnet.near.org/transactions/CDcHeCo4or7kPUXKKvkiVs3ZxQ8khpC9YAddn2LrnsDm |
| Swap (execute_intent) | `7RVtEJeNMC8iEqkqQUgigzUEkWt2DGL11FfQ9U1xaV2t` | https://explorer.testnet.near.org/transactions/7RVtEJeNMC8iEqkqQUgigzUEkWt2DGL11FfQ9U1xaV2t |
| Replay (REFUSED) | `3AFy9LvF7t7L3n96njpX4VnHdRPUk6C9hGbXFmznhUQ3` | https://explorer.testnet.near.org/transactions/3AFy9LvF7t7L3n96njpX4VnHdRPUk6C9hGbXFmznhUQ3 |
| Deposit 4,000.00 | `7qPgqeYaxr3yYdrTcEES6GP2aodX7i2U81uprazTGy64` | https://explorer.testnet.near.org/transactions/7qPgqeYaxr3yYdrTcEES6GP2aodX7i2U81uprazTGy64 |
| Accrue 120.00 yield | `EJsW8jiCRoXmdA3PPxXvXiJNEVtPjqCT1dnLg2SfrSBn` | https://explorer.testnet.near.org/transactions/EJsW8jiCRoXmdA3PPxXvXiJNEVtPjqCT1dnLg2SfrSBn |
| Withdraw 2,000 shares → 2,060.00 | `9KWMoqoBsboQNEnvzSeQA3yKbcd3zmvqGuiJgeB6Fod4` | https://explorer.testnet.near.org/transactions/9KWMoqoBsboQNEnvzSeQA3yKbcd3zmvqGuiJgeB6Fod4 |

Final on-chain state: total assets 2,060.00 USDC, total shares 2,000.0000, share price 1.0300 USDC, solver fees 4.00 USDC, 1 settled intent. Full evidence (including the replay receipt): `docs/testnet-evidence.json`. The quote is a view call on the deployed contract (no tx); its numbers are computed on-chain.

## 5. Deploy to Testnet (reproduce the on-chain evidence)
```bash
npm install
# 1. Build the contract (near-sdk-js; needs its postinstall deps — if the
#    postinstall download fails in a sandbox, run it with --ignore-scripts
#    and fetch binaryen/quickjs/wasi-sdk into
#    node_modules/near-sdk-js/lib/cli/deps/ by hand)
npx near-sdk-js build contract/src/index.js contract/build/contract.wasm
# 2. Create a throwaway testnet account via the free faucet and run the flow.
#    The deployer key is generated in memory and never written to disk.
node scripts/deploy-testnet.mjs [your-account.testnet]
# 3. Re-prove the replay refusal with a capturable tx hash (optional).
node scripts/replay-proof.mjs
```
This writes `docs/testnet-evidence.json` with the contract account, intent hash, and every tx hash. Testnet only — no real money, no mainnet keys.

## 6. Plain Disclosure
- **Zero External Dependencies** for the demo and tests: Node.js standard library only (`node:crypto`, `node:test`, `node:assert`, `node:fs`). The contract build and deploy scripts use `near-sdk-js` / `near-api-js` as dev tooling.
- **No Secrets or Network Calls** in the deterministic demo (`bash docs/verify.sh` -> `ALL CHECKS PASSED`).
- **Computed numbers**: all demo figures come out of `src/engine.mjs` (integer micro-USDC, BigInt); the invariant tests fail if they are tampered with.
- **Stub solver, honestly**: the on-chain `execute_intent()` verifies the quote math and records the intent hash so it cannot settle twice, but it does **not** call `intents.near` `execute_intents` — there is no public testnet deployment of the Intents verifier stack (it lives on mainnet), so a testnet demo cannot settle a real intent. A production solver would submit the signed intent + token diff to `intents.near`. The yield-accrual step is likewise a demo step: the caller supplies the amount and the contract only does the accounting; on mainnet it would be real revenue routed in by the solver.
- **Shared Utility Harness Disclosure**: The SHA-256 hash-chain verification harness (`DeterministicStateMachine`) and `docs/verify.sh` layout are shared across our 7 NEAR Contest Build track entries (`bnty_0422`, `bnty_0420`, `bnty_0419`, `bnty_0417`, `bnty_0416`, `bnty_0412`, `bnty_0411`), while each track's step specifications, domain invariants, and state transitions are tailored to that track.
