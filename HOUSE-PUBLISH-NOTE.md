# House publish note — NEAR DeFi (INTENT-VAULT)

This tree is the house backstop polish for the NEAR DeFi entry. It was prepared by the
house (not by a bounty hunter) as a fallback in case no hunter claims the polish bounty.

## Source
- Upstream: `duongynhi000005-oss/near-agent-economy-contest-builds` @ `5cb1e77`,
  subdirectory `unstoppable-intents-vault/`
- Polish: house backstop, 2026-11-09 (evening PST). No bounty claimed, nothing pushed
  before this staging.
- Polish bounty: **bnty_0565** — still OPEN, hunter None, listing expires Nov 11, 5:05 PM
  PST. This backstop is the fallback if no hunter lands by expiry; if a hunter claims
  and submits, judge theirs on merit.

## Verification (house, live, Nov 9)
- Source note: `BACKSTOP_SUMMARY.md` (house backstop bundle), testnet evidence verified
  live via testnet RPC `tx` queries.
- Re-verified in this staging: `npm test` 10/10 PASS, `bash docs/verify.sh` ALL CHECKS
  PASSED (2026-11-10, Node v24.22.1).
- `node_modules/` (regenerable tooling) was stripped from this tree before publishing.

## Testnet evidence (NEAR testnet)
- Contract: **ivault-backstop-1109.testnet**
  https://explorer.testnet.near.org/accounts/ivault-backstop-1109.testnet
- Intent hash: `6bb60a048b4789e086d18f30ab7a86b56b99e2d5c89a2011f69b9cbc2b0bcb96`
- Transactions (all verified live):
  - Deploy: `CDcHeCo4or7kPUXKKvkiVs3ZxQ8khpC9YAddn2LrnsDm`
  - Swap (execute_intent): `7RVtEJeNMC8iEqkqQUgigzUEkWt2DGL11FfQ9U1xaV2t`
  - Replay (REFUSED, intent_already_settled): `3AFy9LvF7t7L3n96njpX4VnHdRPUk6C9hGbXFmznhUQ3`
  - Deposit 4,000.00: `7qPgqeYaxr3yYdrTcEES6GP2aodX7i2U81uprazTGy64`
  - Accrue 120.00 yield: `EJsW8jiCRoXmdA3PPxXvXiJNEVtPjqCT1dnLg2SfrSBn`
  - Withdraw 2,000 shares → 2,060.00: `9KWMoqoBsboQNEnvzSeQA3yKbcd3zmvqGuiJgeB6Fod4`
- Final on-chain state: assets 2,060.00 USDC, shares 2,000.0000, share price 1.0300 USDC,
  solver fees 4.00 USDC, 1 settled intent.

## Honest caveats (from this tree's README §6, Plain Disclosure)
- **Stub solver, honestly:** the on-chain `execute_intent()` verifies the quote math and
  records the intent hash so it cannot settle twice, but it does **not** call
  `intents.near` `execute_intents` — there is no public testnet deployment of the
  Intents verifier stack (it lives on mainnet), so a testnet demo cannot settle a real
  intent. A production solver would submit the signed intent + token diff to
  `intents.near`.
- **Yield accrual is a demo step:** the caller supplies the amount and the contract only
  does the accounting; on mainnet it would be real revenue routed in by the solver.
- All demo figures are computed in `src/engine.mjs` (integer micro-USDC, BigInt); the
  invariant tests fail if they are tampered with.
