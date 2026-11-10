// Re-prove the replay refusal with a capturable tx hash.
// The deploy script's replay call was refused on-chain (panic:
// intent_already_settled, receipt HwpfjFRpFhfKB74Jm8zVZCwWKncbBTfyWZm6pAr2PPu3)
// but near-api-js retried with a fresh nonce, so the final tx hash was never
// surfaced. This script replays the SAME intent hash from a fresh throwaway
// faucet account, signs locally to learn the hash up-front, then confirms
// the Failure via txStatus.
// Usage: node scripts/replay-proof.mjs
// Writes the result into docs/testnet-evidence.json (replay_refused.tx).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nearApi from 'near-api-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const CONTRACT = 'ivault-backstop-1109.testnet';
const CALLER = 'ivault-replay-1109.testnet';
const HELPER_URL = 'https://helper.testnet.near.org';
const INTENT_HASH = '6bb60a048b4789e086d18f30ab7a86b56b99e2d5c89a2011f69b9cbc2b0bcb96';

async function main() {
  const keyStore = new nearApi.keyStores.InMemoryKeyStore();
  const near = await nearApi.connect({
    networkId: 'testnet',
    nodeUrl: 'https://rpc.testnet.near.org',
    walletUrl: 'https://wallet.testnet.near.org',
    helperUrl: HELPER_URL,
    keyStore,
  });
  const keyPair = nearApi.KeyPair.fromRandom('ed25519');
  await keyStore.setKey('testnet', CALLER, keyPair);
  const res = await fetch(`${HELPER_URL}/account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAccountId: CALLER, newAccountPublicKey: keyPair.getPublicKey().toString() }),
  });
  if (!res.ok) throw new Error(`faucet ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const account = await near.account(CALLER);
  console.log('caller funded:', CALLER);

  const actions = [
    nearApi.transactions.functionCall(
      'execute_intent',
      {
        intent_hash: INTENT_HASH,
        amount_in_micro: '5000000000',
        amount_out_micro: '4996000000',
        solver: 'stub-solver',
      },
      100_000_000_000_000n,
      0n,
    ),
  ];
  const [hashBytes, signedTx] = await account.signTransaction(CONTRACT, actions);
  const txHash58 = nearApi.utils.serialize.base_encode(hashBytes);
  console.log('replay tx hash:', txHash58);
  await near.connection.provider.sendTransactionAsync(signedTx);

  let outcome = null;
  for (let i = 0; i < 12; i++) {
    try {
      outcome = await near.connection.provider.txStatus(txHash58, CALLER);
      break;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!outcome) throw new Error('txStatus never resolved');
  const status = outcome.status;
  console.log('status:', JSON.stringify(status).slice(0, 400));
  if (!status.Failure) throw new Error('replay was NOT refused — unexpected success');
  if (!JSON.stringify(status).includes('intent_already_settled')) {
    throw new Error('failure reason is not intent_already_settled');
  }

  const evidencePath = path.join(rootDir, 'docs', 'testnet-evidence.json');
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  evidence.flow.replay_refused.tx = txHash58;
  evidence.flow.replay_refused.explorer = `https://explorer.testnet.near.org/transactions/${txHash58}`;
  evidence.flow.replay_refused.replayed_by = CALLER;
  evidence.flow.replay_refused.receipt = 'HwpfjFRpFhfKB74Jm8zVZCwWKncbBTfyWZm6pAr2PPu3 (first replay, same intent hash)';
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  console.log('evidence updated:', evidencePath);
}

main().catch((e) => {
  console.error('FAILED:', e.message || e);
  process.exit(1);
});
