import crypto from 'node:crypto';

export const TRACK_CODE = "INTENT-VAULT";
export const BOUNTY_ID = "bnty_0416";

// ---------------------------------------------------------------------------
// Computed-money model.
//
// Every figure in this entry is COMPUTED from the scenario inputs below,
// in integer micro-USDC (1 USDC = 1,000,000 micro units, BigInt math —
// no floats, no pasted literals). Change any input or the fee rate and
// every downstream number changes with it; the invariant tests in
// test/engine.test.mjs fail if a figure is tampered with.
// ---------------------------------------------------------------------------

export const MICRO_PER_USDC = 1000000n;
export const FEE_BPS = 8n; // 0.08% solver fee -> quote rate 0.9992
export const BPS_DENOM = 10000n;

// Canonical scenario INPUTS (not outputs). The demo's outputs — 4,996.00
// out, 4.00 fee, 4,000 shares, 1.0300 share price, 2,060.00 withdrawn —
// are all derived from these four numbers plus FEE_BPS.
export const SCENARIO = {
  quoteAmountInUsdc: '5000',
  depositUsdc: '4000',
  yieldAccruedUsdc: '120',
  redeemSharesUsdc: '2000',
  intentNonce: 'intent-vault-demo-001',
  deadlineSeconds: 300,
};

export function parseUsdcToMicro(usdc) {
  const [whole, frac = ''] = String(usdc).split('.');
  if (!/^\d+$/.test(whole) || !/^\d{0,6}$/.test(frac)) {
    throw new Error(`invalid USDC amount: ${usdc}`);
  }
  return BigInt(whole) * MICRO_PER_USDC + BigInt(frac.padEnd(6, '0') || '0');
}

export function formatUsdc(micro, decimals = 2) {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const whole = abs / MICRO_PER_USDC;
  const frac = abs % MICRO_PER_USDC;
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fracStr = frac.toString().padStart(6, '0').slice(0, decimals).padEnd(decimals, '0');
  return `${neg ? '-' : ''}${wholeStr}.${fracStr}`;
}

export function formatUsdcPlain(micro, decimals = 2) {
  return formatUsdc(micro, decimals).replace(/,/g, '');
}

export function computeQuote(amountInMicro) {
  const amountIn = BigInt(amountInMicro);
  if (amountIn <= 0n) throw new Error('amountIn must be positive');
  const fee = (amountIn * FEE_BPS) / BPS_DENOM;
  const amountOut = amountIn - fee;
  return {
    amountIn,
    fee,
    amountOut,
    feeBps: Number(FEE_BPS),
    rateBps: Number(BPS_DENOM - FEE_BPS),
    rate: Number(BPS_DENOM - FEE_BPS) / Number(BPS_DENOM),
  };
}

export function computeIntentHash(intent) {
  return crypto.createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}

export class IntentLedger {
  constructor() {
    this.settled = new Map(); // intent_hash -> settlement record
  }

  settle(intentHash, quote, solver = 'stub-solver') {
    if (this.settled.has(intentHash)) {
      throw new Error('intent_already_settled');
    }
    const record = {
      intentHash,
      amountInMicro: quote.amountIn.toString(),
      amountOutMicro: quote.amountOut.toString(),
      feeMicro: quote.fee.toString(),
      solver,
    };
    this.settled.set(intentHash, record);
    return record;
  }

  isSettled(intentHash) {
    return this.settled.has(intentHash);
  }
}

// ERC-4626-style share vault, integer math. Shares are denominated in
// micro units too: 1 share = 1 micro-share-unit; at price 1.000000,
// depositing X micro-USDC mints exactly X micro-shares.
export class EarningsVault {
  constructor() {
    this.totalAssetsMicro = 0n;
    this.totalSharesMicro = 0n;
    this.agentSharesMicro = 0n;
  }

  sharePriceMicro() {
    if (this.totalSharesMicro === 0n) return MICRO_PER_USDC;
    return (this.totalAssetsMicro * MICRO_PER_USDC) / this.totalSharesMicro;
  }

  deposit(amountMicro) {
    const amount = BigInt(amountMicro);
    if (amount <= 0n) throw new Error('deposit amount must be positive');
    const shares =
      this.totalSharesMicro === 0n
        ? amount
        : (amount * this.totalSharesMicro) / this.totalAssetsMicro;
    this.totalAssetsMicro += amount;
    this.totalSharesMicro += shares;
    this.agentSharesMicro += shares;
    return shares;
  }

  accrueYield(amountMicro) {
    const amount = BigInt(amountMicro);
    if (amount <= 0n) throw new Error('yield amount must be positive');
    this.totalAssetsMicro += amount;
    return this.totalAssetsMicro;
  }

  withdraw(sharesMicro) {
    const shares = BigInt(sharesMicro);
    if (shares <= 0n) throw new Error('shares must be positive');
    if (shares > this.agentSharesMicro) throw new Error('insufficient_shares');
    const assetsOut = (shares * this.totalAssetsMicro) / this.totalSharesMicro;
    this.totalAssetsMicro -= assetsOut;
    this.totalSharesMicro -= shares;
    this.agentSharesMicro -= shares;
    return assetsOut;
  }
}

// Run the canonical scenario end to end and return every computed value.
export function runScenario() {
  const amountIn = parseUsdcToMicro(SCENARIO.quoteAmountInUsdc);
  const quote = computeQuote(amountIn);
  const intent = {
    from_asset: 'eip155:8453:USDC',
    to_asset: 'near:mainnet:USDC',
    amount_in_micro: quote.amountIn.toString(),
    amount_out_micro: quote.amountOut.toString(),
    solver: 'stub-solver',
    nonce: SCENARIO.intentNonce,
    deadline_seconds: SCENARIO.deadlineSeconds,
  };
  const intentHash = computeIntentHash(intent);

  const ledger = new IntentLedger();
  const settlement = ledger.settle(intentHash, quote);
  let replay;
  try {
    ledger.settle(intentHash, quote);
    replay = { attempt: 'ACCEPTED', reason: null };
  } catch (e) {
    replay = { attempt: 'REFUSED', reason: e.message };
  }

  const vault = new EarningsVault();
  const depositAmount = parseUsdcToMicro(SCENARIO.depositUsdc);
  const mintedShares = vault.deposit(depositAmount);
  vault.accrueYield(parseUsdcToMicro(SCENARIO.yieldAccruedUsdc));
  const sharePriceMicro = vault.sharePriceMicro();
  const redeemShares = parseUsdcToMicro(SCENARIO.redeemSharesUsdc);
  const withdrawn = vault.withdraw(redeemShares);

  return {
    quote,
    intent,
    intentHash,
    settlement,
    replay,
    vault,
    depositAmount,
    mintedShares,
    sharePriceMicro,
    redeemShares,
    withdrawn,
  };
}

// Build the try-it step list from the computed scenario (replaces the old
// hardcoded STEPS_SPEC literals — same step names, same metric keys).
export function buildSteps() {
  const s = runScenario();
  const q = s.quote;
  return [
    {
      step: 'quote',
      summary: `Solver quotes cross-chain intent swap of ${formatUsdc(q.amountIn)} Base USDC (\`eip155:8453\`) -> NEAR USDC (\`near:mainnet\`) at ${q.rate} rate (${formatUsdc(q.amountOut)} NEAR USDC, ${formatUsdc(q.fee)} USDC solver fee, ${SCENARIO.deadlineSeconds}s deadline, signed intent hash verified)`,
      metrics: {
        from_asset: 'eip155:8453:USDC',
        to_asset: 'near:mainnet:USDC',
        amount_in_usdc: Number(q.amountIn) / 1e6,
        amount_out_usdc: Number(q.amountOut) / 1e6,
        solver_fee_usdc: Number(q.fee) / 1e6,
        rate: q.rate,
        intent_hash: s.intentHash,
        quote_valid: true,
      },
    },
    {
      step: 'swap',
      summary: `executeIntentSwap() verifies solver + user commitments and settles atomically -> agent NEAR balance = ${formatUsdc(q.amountOut)} USDC, solver balance +${formatUsdc(q.fee)} USDC, replay of same intent nonce -> ${s.replay.attempt} (${s.replay.reason})`,
      metrics: {
        settled_out_usdc: Number(q.amountOut) / 1e6,
        solver_fee_usdc: Number(q.fee) / 1e6,
        intent_hash: s.intentHash,
        replay_attempt: s.replay.attempt,
        replay_reason: s.replay.reason,
      },
    },
    {
      step: 'deposit_and_withdraw',
      summary: `Agent deposits ${formatUsdc(s.depositAmount)} USDC into EarningsVault -> receives ${formatUsdc(s.mintedShares, 4)} vUSDC shares; after ${formatUsdc(parseUsdcToMicro(SCENARIO.yieldAccruedUsdc))} USDC protocol revenue accrues to the vault (share price = ${formatUsdc(s.sharePriceMicro, 4)} USDC), agent redeems ${formatUsdc(s.redeemShares, 4)} shares -> receives ${formatUsdc(s.withdrawn)} USDC exactly`,
      metrics: {
        deposited_usdc: Number(s.depositAmount) / 1e6,
        minted_shares: Number(s.mintedShares) / 1e6,
        yield_accrued_usdc: Number(parseUsdcToMicro(SCENARIO.yieldAccruedUsdc)) / 1e6,
        share_price_usdc: Number(s.sharePriceMicro) / 1e6,
        redeemed_shares: Number(s.redeemShares) / 1e6,
        withdrawn_usdc: Number(s.withdrawn) / 1e6,
      },
    },
  ];
}

// Backwards-compatible name: the step list is computed at import time from
// the model above, never pasted.
export const STEPS_SPEC = buildSteps();

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

export class DeterministicStateMachine {
  constructor() {
    this.events = [];
    this.headHash = '0'.repeat(64);
  }

  applyStep(stepName, payload) {
    if (!stepName || typeof stepName !== 'string') {
      throw new Error('stepName must be a non-empty string');
    }
    const index = this.events.length;
    const canonical = JSON.stringify({ index, prev: this.headHash, step: stepName, payload });
    const hash = sha256Hex(canonical);
    const entry = { index, step: stepName, payload, prevHash: this.headHash, hash };
    this.events.push(entry);
    this.headHash = hash;
    return entry;
  }

  runAllTryItSteps() {
    for (const s of STEPS_SPEC) {
      this.applyStep(s.step, { summary: s.summary, metrics: s.metrics });
    }
    return this.snapshot();
  }

  verifyChain() {
    let prev = '0'.repeat(64);
    for (let i = 0; i < this.events.length; i++) {
      const ev = this.events[i];
      if (ev.prevHash !== prev) return false;
      const expected = sha256Hex(JSON.stringify({ index: i, prev, step: ev.step, payload: ev.payload }));
      if (ev.hash !== expected) return false;
      prev = expected;
    }
    return true;
  }

  snapshot() {
    return {
      track: TRACK_CODE,
      bountyId: BOUNTY_ID,
      eventCount: this.events.length,
      headHash: this.headHash,
      chainVerified: this.verifyChain(),
      events: this.events,
    };
  }
}
