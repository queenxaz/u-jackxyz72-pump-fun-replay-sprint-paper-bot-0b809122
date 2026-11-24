// Long Rider — a pump.fun paper-trading bot for agent-fun/replay/v2.
//
// The harness speaks to this bot on stdin/stdout: one `hello` line first
// (capital, caps, fees, seed), then one `batch` per slot carrying that slot's
// chain events, marks and fills, and finally `done`. Every batch this bot
// answers with exactly one reply line holding its `orders` for that slot;
// orders decided on a batch for slot s fill at slot s + latency_slots. The
// bot is executed twice on the same data and the two action logs must match
// byte for byte, so it reads no clock, no environment and no randomness —
// every decision comes from the batches.
//
// Strategy, in short:
//   * Watch every new bonding curve from its CreateEvent. Buy only launches
//     that pass a rug filter while they are still young (first MAX_AGE
//     slots): the curve already holds real SOL (MIN_REAL_SOL..MAX_REAL_SOL),
//     the creator's own buys are bounded (MAX_DEV_BUY_SOL), at most
//     MAX_BUYERS distinct other wallets have bought in (a launch bundled by
//     many wallets is a dump in waiting), and the creator has not sold.
//     One buy per coin; the size is capped at 1% of the curve's real SOL
//     reserve, so early buys are small by construction.
//   * Sell a whole position on the first of: take-profit (+TAKE_PROFIT_BPS),
//     stop-loss (STOP_LOSS_BPS), a trailing stop once the position has run up
//     (TRAIL_ARM_BPS, then a TRAIL_DROP_BPS pullback from its best value),
//     or a MAX_HOLD_SLOTS time stop. Exits are judged on the constant-product
//     sale value of the position (what selling the tokens against the curve
//     would actually pay after the 1.25% curve fee), not on a linear price.
//     The take-profit here is wide (+200%): on a 24-hour window the rare
//     runner needs room to run to completion, and the trailing stop banks
//     the gain if it turns.
//   * No exit on creator selling: creators sell small amounts constantly,
//     and exiting on every creator sale churns the book into fees. The
//     stop-loss and the time stop do that job instead.
//   * Long holds, few round trips, small stakes: fees are ~1.25% a side plus
//     a flat tx fee, so the bot trades rarely and lets the rare runner run.
//
// No network, no files outside this repository, no secrets: everything the
// bot runs is in this repo. Standard library only, plus the vendored SDK shim.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- parameters

/** Lamports aimed for per coin (each buy is still capped at 1% of real SOL). */
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 2n;
/** Smallest single buy worth paying the tx fee for. */
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 200n;
/** Youngest age (slots since create) at which a coin may be bought. */
const MIN_AGE_SLOTS = 0;
/** Oldest age at which a first buy may still be decided. */
const MAX_AGE_SLOTS = 30;
/** Real SOL reserve window at decision time. */
const MIN_REAL_SOL = (LAMPORTS_PER_SOL * 3n) / 10n; // 0.3 SOL
const MAX_REAL_SOL = LAMPORTS_PER_SOL * 30n; // 30 SOL
/** Creator's own buys: at most this much before entry. */
const MAX_DEV_BUY_SOL = (LAMPORTS_PER_SOL * 5n) / 2n; // 2.5 SOL
/** Distinct non-creator buyers before entry, at most. */
const MAX_BUYERS = 5;
/** Take-profit: sell when the sale value reaches this over cost (bps). */
const TAKE_PROFIT_BPS = 20000; // +200%
/** Stop-loss: sell when the sale value falls to this under cost (bps). */
const STOP_LOSS_BPS = -3000; // -30%
/** Trailing stop arms once the sale value reaches this over cost (bps). */
const TRAIL_ARM_BPS = 10000; // +100%
/** Once armed, sell on a pullback of this many bps from the best value. */
const TRAIL_DROP_BPS = 3000; // -30% from peak
/** Time stop: sell whatever is left after this many slots held. */
const MAX_HOLD_SLOTS = 40000;
/** Slippage allowance (bps). Wide, so a fast-moving curve never refuses a
 *  fill for the 2-slot latency; the curve still sets the price. */
const SLIPPAGE_BPS = 10000;
/** Curve fee: protocol 95 bps + creator 30 bps. */
const FEE_BPS = 125n;
const BPS = 10000n;

// ---------------------------------------------------------------- tape

interface Coin {
  mint: string;
  createdSlot: number;
  creator: string;
  /** Creator's own buys so far, in lamports. */
  devBuy: bigint;
  /** Distinct non-creator buyers so far. */
  buyers: Set<string>;
  /** The creator has sold. */
  devSold: boolean;
  /** Trades seen. */
  trades: number;
  /** Never buy it again (bought, filtered out for good, or completed). */
  decided: boolean;
  complete: boolean;
}

interface Held {
  entrySlot: number;
  /** Best sale value over cost seen so far, in bps (0 = break-even). */
  peakBps: number;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

// ---------------------------------------------------------------- the bot

const coins = new Map<string, Coin>();
const held = new Map<string, Held>();

function coinFor(mint: string, slot: number, creator: string): Coin {
  let c = coins.get(mint);
  if (c === undefined) {
    c = {
      mint,
      createdSlot: slot,
      creator,
      devBuy: 0n,
      buyers: new Set<string>(),
      devSold: false,
      trades: 0,
      decided: false,
      complete: false,
    };
    coins.set(mint, c);
  }
  return c;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const orders: OrderInput[] = [];
    const touched = new Set<string>();

    // Fold this batch's events into the tapes. The hello line already told
    // us the caps; the batch carries the events, marks and fills for its slot.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const c = coinFor(e.mint, e.slot, e.creator);
        c.createdSlot = e.slot;
        c.creator = e.creator;
        touched.add(e.mint);
      } else if (e.event === 'TradeEvent') {
        const c = coinFor(e.mint, e.slot, '');
        c.trades += 1;
        const sol = BigInt(e.sol_amount);
        if (e.is_buy) {
          if (e.user === c.creator) c.devBuy += sol;
          else c.buyers.add(e.user);
        } else if (e.user === c.creator) {
          c.devSold = true;
        }
        touched.add(e.mint);
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) c.complete = true;
      }
    }

    // ---- exits first: they free slots for fresh entries -----------------
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    }
    for (const [mint, h] of [...state.positions.entries()].sort()) {
      if (pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const value = sellValue(
        BigInt(h.token_amount),
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
      );
      const cost = BigInt(h.cost_lamports);
      if (cost <= 0n || value <= 0n) continue;
      const gainBps = Number(((value - cost) * BPS) / cost);
      let rec = held.get(mint);
      if (rec === undefined) {
        rec = { entrySlot: slot, peakBps: gainBps };
        held.set(mint, rec);
      }
      if (gainBps > rec.peakBps) rec.peakBps = gainBps;
      const ageSlots = slot - rec.entrySlot;
      const trailing =
        rec.peakBps >= TRAIL_ARM_BPS && gainBps <= rec.peakBps - TRAIL_DROP_BPS;
      if (
        gainBps >= TAKE_PROFIT_BPS ||
        gainBps <= STOP_LOSS_BPS ||
        trailing ||
        ageSlots >= MAX_HOLD_SLOTS
      ) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: h.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        } as SellInput);
      }
    }
    // Forget positions that are gone (sold, completed, flattened).
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    // ---- entries: young launches that pass the rug filter ---------------
    const caps = state.hello.caps;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    // Sells issued this batch free their slot for the entries below.
    slots += orders.filter((o) => o.side === 'sell').length;

    for (const mint of [...touched].sort()) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      const c = coins.get(mint);
      if (c === undefined || c.decided || c.complete) continue;
      const age = slot - c.createdSlot;
      if (age > MAX_AGE_SLOTS) {
        c.decided = true;
        continue;
      }
      if (age < MIN_AGE_SLOTS) continue;
      if (state.positions.has(mint)) {
        c.decided = true;
        continue;
      }
      let pendingBuy = false;
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy' && p.order.mint === mint) {
          pendingBuy = true;
          break;
        }
      }
      if (pendingBuy) continue;
      // Rug filter: real SOL in window, creator buys bounded, few buyers,
      // creator has not sold.
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      const realSol = curve.real_quote_reserves;
      if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) continue;
      if (c.devBuy > MAX_DEV_BUY_SOL) continue;
      if (c.buyers.size > MAX_BUYERS) continue;
      if (c.devSold) continue;

      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: SLIPPAGE_BPS,
      } as BuyInput);
      c.decided = true;
      free -= amount + tx;
      slots -= 1;
    }

    // ---- housekeeping: drop stale tapes now and then ---------------------
    if (slot % 4096 === 0) {
      for (const [mint, c] of coins) {
        if (!state.positions.has(mint) && slot - c.createdSlot > MAX_HOLD_SLOTS + 4096) {
          coins.delete(mint);
        }
      }
    }

    return orders;
  },
});
