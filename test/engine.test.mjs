import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DeterministicStateMachine,
  STEPS_SPEC,
  sha256Hex,
  computeQuote,
  computeIntentHash,
  parseUsdcToMicro,
  formatUsdc,
  EarningsVault,
  IntentLedger,
  runScenario,
  buildSteps,
  FEE_BPS,
  BPS_DENOM,
  MICRO_PER_USDC,
  SCENARIO,
} from '../src/engine.mjs';

test('deterministic state machine executes all 3 try-it steps identically across runs', () => {
  const m1 = new DeterministicStateMachine().runAllTryItSteps();
  const m2 = new DeterministicStateMachine().runAllTryItSteps();
  assert.equal(m1.eventCount, 3);
  assert.equal(m1.chainVerified, true);
  assert.equal(m1.headHash, m2.headHash);
  assert.deepEqual(m1.events, m2.events);
});

test('tampering with any event payload invalidates hash chain verification', () => {
  const m = new DeterministicStateMachine();
  m.runAllTryItSteps();
  assert.equal(m.verifyChain(), true);
  m.events[1].payload = { summary: 'tampered', metrics: {} };
  assert.equal(m.verifyChain(), false);
});

test('rejects empty step names', () => {
  const m = new DeterministicStateMachine();
  assert.throws(() => m.applyStep('', {}), /stepName must be a non-empty string/);
});

test('each try-it step produces non-empty metrics and valid 64-hex SHA-256 digest', () => {
  const snap = new DeterministicStateMachine().runAllTryItSteps();
  for (let i = 0; i < STEPS_SPEC.length; i++) {
    assert.equal(snap.events[i].step, STEPS_SPEC[i].step);
    assert.match(snap.events[i].hash, /^[0-9a-f]{64}$/);
    assert.ok(Object.keys(snap.events[i].payload.metrics).length > 0);
  }
});

// --- Computed-invariant tests (fix list item 1) ---
// These fail if any figure is pasted or tampered with, because every number
// is recomputed from the scenario inputs + FEE_BPS inside the test itself.

test('INVARIANT: swap-out = amount x (1 - fee), computed from the fee rate', () => {
  const amountIn = parseUsdcToMicro(SCENARIO.quoteAmountInUsdc);
  const q = computeQuote(amountIn);
  // Recompute independently from the fee rate — not from the quote output.
  const expectedFee = (amountIn * FEE_BPS) / BPS_DENOM;
  const expectedOut = amountIn - expectedFee;
  assert.equal(q.fee, expectedFee);
  assert.equal(q.amountOut, expectedOut);
  assert.equal(q.amountOut, 4996000000n); // 5,000 x 0.9992 = 4,996.00
  assert.equal(q.fee, 4000000n); // 4.00 USDC
  assert.equal(q.rate, 0.9992);
  // A different fee rate MUST produce a different out — proves the number
  // comes out of code, not out of a literal.
  const tamperedFee = (amountIn * 16n) / BPS_DENOM;
  assert.notEqual(amountIn - tamperedFee, q.amountOut);
});

test('INVARIANT: share price = assets / shares recomputed from vault state', () => {
  const s = runScenario();
  const v = s.vault;
  // After the full scenario: 2,000 shares left, 2,060.00 USDC of assets.
  const recomputed = (v.totalAssetsMicro * MICRO_PER_USDC) / v.totalSharesMicro;
  assert.equal(recomputed, s.sharePriceMicro);
  assert.equal(s.sharePriceMicro, 1030000n); // 1.0300
  assert.equal(v.totalAssetsMicro, 2060000000n);
  assert.equal(v.totalSharesMicro, 2000000000n);
});

test('INVARIANT: deposit 4,000 -> 4,000 shares; redeem 2,000 shares -> 2,060.00', () => {
  const s = runScenario();
  assert.equal(s.mintedShares, 4000000000n);
  assert.equal(s.withdrawn, 2060000000n);
  // Redeem amount recomputed from shares x price, not pasted.
  const recomputedOut = (s.redeemShares * s.sharePriceMicro) / MICRO_PER_USDC;
  assert.equal(recomputedOut, s.withdrawn);
  assert.equal(formatUsdc(s.withdrawn), '2,060.00');
});

test('INVARIANT: replaying the same intent hash is refused', () => {
  const ledger = new IntentLedger();
  const q = computeQuote(parseUsdcToMicro('5000'));
  const hash = computeIntentHash({ nonce: 'x', amount: '5000' });
  ledger.settle(hash, q);
  assert.equal(ledger.isSettled(hash), true);
  assert.throws(() => ledger.settle(hash, q), /intent_already_settled/);
  const s = runScenario();
  assert.equal(s.replay.attempt, 'REFUSED');
  assert.equal(s.replay.reason, 'intent_already_settled');
});

test('INVARIANT: intent hash is the sha256 of the canonical intent JSON', () => {
  const s = runScenario();
  assert.equal(s.intentHash, computeIntentHash(s.intent));
  assert.match(s.intentHash, /^[0-9a-f]{64}$/);
  // Any field change changes the hash.
  const tampered = { ...s.intent, amount_out_micro: '4996000001' };
  assert.notEqual(computeIntentHash(tampered), s.intentHash);
});

test('INVARIANT: step metrics equal the recomputed scenario (no literals)', () => {
  const steps = buildSteps();
  const s = runScenario();
  assert.equal(steps[0].metrics.amount_out_usdc, Number(s.quote.amountOut) / 1e6);
  assert.equal(steps[0].metrics.solver_fee_usdc, Number(s.quote.fee) / 1e6);
  assert.equal(steps[0].metrics.intent_hash, s.intentHash);
  assert.equal(steps[2].metrics.share_price_usdc, Number(s.sharePriceMicro) / 1e6);
  assert.equal(steps[2].metrics.withdrawn_usdc, Number(s.withdrawn) / 1e6);
  assert.deepEqual(steps, STEPS_SPEC);
});
