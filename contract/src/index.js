// INTENT-VAULT on-chain contract (NEAR testnet).
// Minimal ERC-4626-style share vault + stub-solver intent settlement.
// All money math is integer micro-USDC (1 USDC = 1,000,000 micro units),
// computed with BigInt and stored as decimal strings — no floats, no literals.
//
// Honest scope: this is a MINIMAL vault, not the production NEAR Intents
// solver. The "solver" here is a stub: execute_intent() verifies the quote
// math on-chain (amount_out must equal amount_in x (1 - fee)) and records
// the intent hash so it cannot settle twice. A real solver would call
// intents.near `execute_intents` with a signed multi-token diff; this
// contract proves the vault accounting and the intent-hash discipline
// on-chain, and the README says so.
import { NearBindgen, near, call, view } from 'near-sdk-js';

const FEE_BPS = 8n; // 0.08% solver fee -> quote rate 0.9992
const BPS_DENOM = 10000n;
const SCALE = 1000000n; // micro units per USDC

@NearBindgen({})
class IntentVault {
  constructor() {
    this.total_assets_micro = '0';
    this.total_shares_micro = '0';
    this.agent_balance_micro = '0'; // settled swap proceeds awaiting deposit
    this.solver_fees_micro = '0';
    this.settled_intents = {}; // intent_hash -> settlement record
    this.share_balances = {}; // account_id -> shares (micro, as string)
    this.flow_events = []; // append-only log of flow steps, capped at 50
  }

  _sharePriceMicro() {
    const assets = BigInt(this.total_assets_micro);
    const shares = BigInt(this.total_shares_micro);
    if (shares === 0n) return '1000000'; // 1.000000 before first deposit
    return ((assets * SCALE) / shares).toString();
  }

  _log(step, detail) {
    this.flow_events.push({ step, ...detail });
    if (this.flow_events.length > 50) this.flow_events.shift();
  }

  // ---- views ----

  @view({})
  quote({ amount_in_micro }) {
    const amountIn = BigInt(amount_in_micro);
    if (amountIn <= 0n) throw new Error('amount_in_micro must be positive');
    const fee = (amountIn * FEE_BPS) / BPS_DENOM;
    const amountOut = amountIn - fee;
    return {
      amount_in_micro: amountIn.toString(),
      fee_micro: fee.toString(),
      amount_out_micro: amountOut.toString(),
      fee_bps: 8,
      rate_bps: 9992,
    };
  }

  @view({})
  get_state({}) {
    return {
      total_assets_micro: this.total_assets_micro,
      total_shares_micro: this.total_shares_micro,
      share_price_micro: this._sharePriceMicro(),
      agent_balance_micro: this.agent_balance_micro,
      solver_fees_micro: this.solver_fees_micro,
      settled_intent_count: Object.keys(this.settled_intents).length,
    };
  }

  @view({})
  get_intent({ intent_hash }) {
    return this.settled_intents[intent_hash] || null;
  }

  @view({})
  get_shares({ account_id }) {
    return { account_id, shares_micro: this.share_balances[account_id] || '0' };
  }

  @view({})
  get_events({}) {
    return this.flow_events;
  }

  // ---- calls ----

  @call({})
  execute_intent({ intent_hash, amount_in_micro, amount_out_micro, solver }) {
    if (!intent_hash || typeof intent_hash !== 'string') {
      throw new Error('intent_hash required');
    }
    if (this.settled_intents[intent_hash]) {
      throw new Error('intent_already_settled');
    }
    const amountIn = BigInt(amount_in_micro);
    const amountOut = BigInt(amount_out_micro);
    const fee = (amountIn * FEE_BPS) / BPS_DENOM;
    if (amountOut !== amountIn - fee) {
      throw new Error('amount_out_mismatch: out must equal in x (1 - fee)');
    }
    this.settled_intents[intent_hash] = {
      amount_in_micro: amountIn.toString(),
      amount_out_micro: amountOut.toString(),
      fee_micro: fee.toString(),
      solver: solver || 'stub-solver',
      settled_by: near.predecessorAccountId(),
    };
    this.agent_balance_micro = (BigInt(this.agent_balance_micro) + amountOut).toString();
    this.solver_fees_micro = (BigInt(this.solver_fees_micro) + fee).toString();
    this._log('swap', { intent_hash, amount_out_micro: amountOut.toString() });
    return {
      intent_hash,
      amount_out_micro: amountOut.toString(),
      agent_balance_micro: this.agent_balance_micro,
    };
  }

  @call({})
  deposit({ amount_micro }) {
    const amount = BigInt(amount_micro);
    if (amount <= 0n) throw new Error('amount_micro must be positive');
    if (BigInt(this.agent_balance_micro) < amount) {
      throw new Error('insufficient_settled_balance');
    }
    const assetsBefore = BigInt(this.total_assets_micro);
    const sharesBefore = BigInt(this.total_shares_micro);
    const shares =
      sharesBefore === 0n ? amount : (amount * sharesBefore) / assetsBefore;
    const caller = near.predecessorAccountId();
    this.agent_balance_micro = (BigInt(this.agent_balance_micro) - amount).toString();
    this.total_assets_micro = (assetsBefore + amount).toString();
    this.total_shares_micro = (sharesBefore + shares).toString();
    this.share_balances[caller] = (
      BigInt(this.share_balances[caller] || '0') + shares
    ).toString();
    this._log('deposit', { amount_micro: amount.toString(), shares_minted_micro: shares.toString() });
    return {
      shares_minted_micro: shares.toString(),
      share_price_micro: this._sharePriceMicro(),
      total_assets_micro: this.total_assets_micro,
      total_shares_micro: this.total_shares_micro,
    };
  }

  // Demo step: simulates protocol revenue accruing to the vault.
  // On mainnet this would be real yield routed in by the solver; here the
  // caller supplies the amount and the contract only does the accounting.
  @call({})
  accrue_yield({ amount_micro }) {
    const amount = BigInt(amount_micro);
    if (amount <= 0n) throw new Error('amount_micro must be positive');
    this.total_assets_micro = (BigInt(this.total_assets_micro) + amount).toString();
    this._log('accrue_yield', { amount_micro: amount.toString() });
    return {
      total_assets_micro: this.total_assets_micro,
      share_price_micro: this._sharePriceMicro(),
    };
  }

  @call({})
  withdraw({ shares_micro }) {
    const shares = BigInt(shares_micro);
    if (shares <= 0n) throw new Error('shares_micro must be positive');
    const caller = near.predecessorAccountId();
    const held = BigInt(this.share_balances[caller] || '0');
    if (held < shares) throw new Error('insufficient_shares');
    const assetsOut =
      (shares * BigInt(this.total_assets_micro)) / BigInt(this.total_shares_micro);
    this.share_balances[caller] = (held - shares).toString();
    this.total_assets_micro = (BigInt(this.total_assets_micro) - assetsOut).toString();
    this.total_shares_micro = (BigInt(this.total_shares_micro) - shares).toString();
    this.agent_balance_micro = (BigInt(this.agent_balance_micro) + assetsOut).toString();
    this._log('withdraw', { shares_micro: shares.toString(), assets_out_micro: assetsOut.toString() });
    return {
      assets_out_micro: assetsOut.toString(),
      share_price_micro: this._sharePriceMicro(),
      agent_balance_micro: this.agent_balance_micro,
    };
  }
}
