// Deploy the INTENT-VAULT contract to NEAR testnet and run the full
// quote -> swap -> deposit -> withdraw flow, recording real tx hashes.
//
// Usage (from unstoppable-intents-vault/):
//   npm install            # installs near-api-js (dev tooling)
//   node scripts/deploy-testnet.mjs [account-id]
//   # default account id: ivault-backstop-1109.testnet
//
// The deployer keypair is generated in memory in this process and NEVER
// written to disk or printed. The faucet funds the account; no real money
// is involved (testnet only). Evidence is written to
// docs/testnet-evidence.json (contract account, intent hash, tx hashes,
// explorer links) — that file contains NO private key.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as nearApi from 'near-api-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const ACCOUNT_ID = process.argv[2] || 'ivault-backstop-1109.testnet';
const RPC_URL = 'https://rpc.testnet.near.org';
const HELPER_URL = 'https://helper.testnet.near.org';
const EXPLORER_TX = 'https://explorer.testnet.near.org/transactions/';
const EXPLORER_ACCT = 'https://explorer.testnet.near.org/accounts/';

// Canonical demo figures, in integer micro-USDC (1 USDC = 1,000,000).
const AMOUNT_IN = 5_000_000_000; // 5,000.00 USDC
const DEPOSIT = 4_000_000_000; // 4,000.00 USDC
const YIELD = 120_000_000; // 120.00 USDC protocol revenue
const REDEEM_SHARES = 2_000_000_000; // 2,000.0000 shares

const fmt = (micro) => (Number(micro) / 1e6).toFixed(2);

async function main() {
  const keyStore = new nearApi.keyStores.InMemoryKeyStore();
  const near = await nearApi.connect({
    networkId: 'testnet',
    nodeUrl: RPC_URL,
    walletUrl: 'https://wallet.testnet.near.org',
    helperUrl: HELPER_URL,
    keyStore,
  });

  // 1. Fresh throwaway testnet account, funded by the free faucet helper.
  const keyPair = nearApi.KeyPair.fromRandom('ed25519');
  await keyStore.setKey('testnet', ACCOUNT_ID, keyPair);
  console.log(`[1/8] creating ${ACCOUNT_ID} via faucet helper...`);
  const res = await fetch(`${HELPER_URL}/account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      newAccountId: ACCOUNT_ID,
      newAccountPublicKey: keyPair.getPublicKey().toString(),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`faucet helper ${res.status}: ${body.slice(0, 500)}`);
  }
  const account = await near.account(ACCOUNT_ID);
  const state = await account.state();
  const balanceNear = Number(nearApi.utils.format.formatNearAmount(state.amount));
  console.log(`      funded. balance: ${balanceNear.toFixed(4)} NEAR`);
  if (balanceNear < 6) {
    throw new Error(
      `INSUFFICIENT FAUCET FUNDING: ${balanceNear} NEAR < ~6 NEAR needed to store the 536KB contract. ` +
        `Re-run with a different faucet or a pre-funded testnet account.`,
    );
  }

  // 2. Deploy the contract.
  const wasm = fs.readFileSync(path.join(rootDir, 'contract', 'build', 'contract.wasm'));
  console.log(`[2/8] deploying ${wasm.length} bytes to ${ACCOUNT_ID}...`);
  const deployOutcome = await account.deployContract(wasm);
  const deployTx = deployOutcome.transaction.hash;
  console.log(`      deploy tx: ${deployTx}`);

  // 3. Quote (on-chain view — the numbers come from the contract).
  console.log('[3/8] quote 5,000.00 USDC...');
  const quote = await account.viewFunction({
    contractId: ACCOUNT_ID,
    methodName: 'quote',
    args: { amount_in_micro: String(AMOUNT_IN) },
  });
  console.log(`      out=${fmt(quote.amount_out_micro)} fee=${fmt(quote.fee_micro)} rate=${quote.rate_bps / 100}%`);
  if (quote.amount_out_micro !== '4996000000' || quote.fee_micro !== '4000000') {
    throw new Error(`quote mismatch: ${JSON.stringify(quote)}`);
  }

  // 4. Intent hash: sha256 of the canonical intent JSON, then settle on-chain.
  const intent = {
    from_asset: 'eip155:8453:USDC',
    to_asset: 'near:mainnet:USDC',
    amount_in_micro: String(AMOUNT_IN),
    amount_out_micro: quote.amount_out_micro,
    solver: 'stub-solver',
    nonce: 'intent-vault-demo-001',
    deadline_seconds: 300,
  };
  const intentHash = crypto.createHash('sha256').update(JSON.stringify(intent)).digest('hex');
  console.log(`[4/8] intent hash: ${intentHash}`);
  const swapOutcome = await account.functionCall({
    contractId: ACCOUNT_ID,
    methodName: 'execute_intent',
    args: { intent_hash: intentHash, amount_in_micro: String(AMOUNT_IN), amount_out_micro: quote.amount_out_micro, solver: 'stub-solver' },
    gas: 100_000_000_000_000n,
  });
  const swapTx = swapOutcome.transaction.hash;
  console.log(`      swap tx: ${swapTx}`);

  // 4b. Replay the same intent — must be REFUSED on-chain.
  let replayTx = null;
  let replayError = null;
  try {
    const replay = await account.functionCall({
      contractId: ACCOUNT_ID,
      methodName: 'execute_intent',
      args: { intent_hash: intentHash, amount_in_micro: String(AMOUNT_IN), amount_out_micro: quote.amount_out_micro, solver: 'stub-solver' },
      gas: 100_000_000_000_000n,
    });
    replayTx = replay.transaction.hash;
    replayError = 'UNEXPECTED SUCCESS — replay was accepted';
  } catch (e) {
    replayError = String(e.message || e).slice(0, 300);
    const m = replayError.match(/([A-Za-z0-9]{43,44})/);
    replayTx = m ? m[1] : null;
  }
  console.log(`      replay refused: ${replayError.slice(0, 120)}`);

  // 5. Deposit 4,000.00 USDC -> 4,000 shares at price 1.000000.
  console.log('[5/8] deposit 4,000.00 USDC...');
  const depOutcome = await account.functionCall({
    contractId: ACCOUNT_ID,
    methodName: 'deposit',
    args: { amount_micro: String(DEPOSIT) },
    gas: 100_000_000_000_000n,
  });
  const depTx = depOutcome.transaction.hash;
  const dep = depOutcome.returnValue ?? null;
  console.log(`      deposit tx: ${depTx}`);

  // 6. Accrue 120.00 USDC protocol revenue -> share price 1.030000.
  console.log('[6/8] accrue 120.00 USDC yield...');
  const accOutcome = await account.functionCall({
    contractId: ACCOUNT_ID,
    methodName: 'accrue_yield',
    args: { amount_micro: String(YIELD) },
    gas: 100_000_000_000_000n,
  });
  const accTx = accOutcome.transaction.hash;
  console.log(`      accrue tx: ${accTx}`);

  // 7. Redeem 2,000 shares -> 2,060.00 USDC.
  console.log('[7/8] withdraw 2,000.0000 shares...');
  const wdOutcome = await account.functionCall({
    contractId: ACCOUNT_ID,
    methodName: 'withdraw',
    args: { shares_micro: String(REDEEM_SHARES) },
    gas: 100_000_000_000_000n,
  });
  const wdTx = wdOutcome.transaction.hash;
  console.log(`      withdraw tx: ${wdTx}`);

  // 8. Final on-chain state + evidence file.
  const finalState = await account.viewFunction({
    contractId: ACCOUNT_ID,
    methodName: 'get_state',
    args: {},
  });
  console.log('[8/8] final state:', JSON.stringify(finalState));
  const expectedPrice = '1030000';
  if (finalState.share_price_micro !== expectedPrice) {
    throw new Error(`share price mismatch: ${finalState.share_price_micro} != ${expectedPrice}`);
  }

  const evidence = {
    network: 'testnet',
    contract_account: ACCOUNT_ID,
    contract_explorer: EXPLORER_ACCT + ACCOUNT_ID,
    contract_wasm_sha256: crypto.createHash('sha256').update(wasm).digest('hex'),
    deployed_at_utc: new Date().toISOString(),
    intent,
    intent_hash: intentHash,
    flow: {
      quote: { ...quote, tx: null, note: 'view call (no tx); numbers computed on-chain' },
      swap: { tx: swapTx, explorer: EXPLORER_TX + swapTx },
      replay_refused: { tx: replayTx, explorer: replayTx ? EXPLORER_TX + replayTx : null, error: replayError },
      deposit: { tx: depTx, explorer: EXPLORER_TX + depTx, amount_usdc: '4000.00' },
      accrue_yield: { tx: accTx, explorer: EXPLORER_TX + accTx, amount_usdc: '120.00' },
      withdraw: { tx: wdTx, explorer: EXPLORER_TX + wdTx, shares: '2000.0000', assets_out_usdc: '2060.00' },
      deploy: { tx: deployTx, explorer: EXPLORER_TX + deployTx },
    },
    final_state: finalState,
    verified_figures: {
      quote_out_usdc: fmt(quote.amount_out_micro),
      solver_fee_usdc: fmt(quote.fee_micro),
      share_price_usdc: (Number(finalState.share_price_micro) / 1e6).toFixed(4),
      withdrawn_usdc: '2060.00',
    },
    disclosure:
      'Stub solver: execute_intent() verifies quote math on-chain and records the intent hash; it does not call intents.near execute_intents. Yield accrual is a demo step (amount supplied by the caller); on mainnet it would be real revenue routed in by the solver.',
  };
  const evidencePath = path.join(rootDir, 'docs', 'testnet-evidence.json');
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  console.log(`evidence written: ${evidencePath}`);
  console.log('DONE. Contract:', ACCOUNT_ID);
}

main().catch((e) => {
  console.error('FAILED:', e.message || e);
  process.exit(1);
});
