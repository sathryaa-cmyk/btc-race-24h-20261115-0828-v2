// Sentinel v2: a selective deep-dip long-only cbBTC bot for
// make.fun btc-race-24h-20261115-0828.
//
// Round 1 ("Sentinel") made +$24.57 on the dev window with a 120 bps dip
// trigger and a +4.0% take-profit. This revision retunes the two constants
// the dev window actually binds on, and adds a backup trigger for a
// slow-grind race day:
//
//   main leg -- deep-dip mean reversion: 60-min return <= -180 bps
//       (was -120) AND the drop has paused (15-min return >= +20 bps).
//       The -120 trigger also bought the hour-13 dip, which then fell a
//       further -3% and stopped out for -$9; -180 skips that leg entirely
//       and only buys the hour-16/17 capitulation, at the turn bar
//       (decision close $62,332.95). Exits: +4.5% take-profit (was +4.0%);
//       the recovery runs to $65,480, so +4.0% sells $470 early while
//       +4.5% sells at the peak close. -1.2% hard stop; trailing stop 1.5%
//       below the peak close, armed once +1.0% in profit; 240-bar time stop.
//   backup leg -- washout: a -5.0% fall over 360 bars, the close within
//       0.5% of the 360-bar low, paused 3 bars, AND the 60-min return
//       above -180 bps (a slow grind, not a sharp drop -- the sharp case
//       is the main leg's, and the two triggers are mutually exclusive on
//       any one bar). Exits: +4.5% price-target take-profit, 2.0% trailing
//       stop on value, -1.5% hard stop, 1440-bar time stop. On the dev
//       window this leg never fires (whenever the 360-min fall reaches
//       -5%, the 60-min fall is already past -180 bps), so the dev score
//       is the main leg's alone; on a grindy race day it is the only leg
//       that can fire at all.
//   cooldown: 10 bars after any exit; 60 bars after a stop-loss exit.
//
// Measured on the published dev window with an exact local replay of the
// harness (fee 4 bps, slippage 2 bps, fill at the next bar's open against
// the pool depth, max slippage 100 bps):
//   buy bar 1046 @ $62,455.57, sell bar 1113 @ $65,341.14
//   net PnL +$45.36 USDC, 2 trades (1 round trip), max drawdown 0.47%,
//   deterministic.
//
// Robustness (one parameter varied at a time, all else at the base):
//   dip 170-190 bps -> +$45.36 (150 takes the losing hour-13 leg,
//   +$28.37; 200 never fires, $0); turn 10-30 bps -> +$45.36
//   (40 never fires); take-profit 4.25-4.75% -> +$45.36
//   (4.0% -> +$39.54, 4.9% -> +$32.44, trailing exit); trailing,
//   arm, stop, hold, range and spike filters do not bind on this window.
//   The washout backup at DROP 500 with the -180 bps gate leaves the dev
//   score unchanged at +$45.36; ungated it pre-empts the main leg for
//   +$44.34, and at DROP 425 it fires mid-fall for +$39.90.
//   The chosen values sit in the middle of their plateaus.
//
// All bps arithmetic is integer floor division on the harness's own price
// units, so the bot is exactly deterministic: no randomness, no wall
// clock, no network, no files. A full-size round trip costs ~26 bps in
// fees, slippage and impact, so a trade only makes sense when the
// expected move is far larger than that -- which is what the deep-dip
// filter is for.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const DIP_BPS = 180; // 60-min drop that marks a deep dip
const DIP_TURN_BPS = 20; // 15-min rise that confirms the drop has paused
const RANGE_MIN_BPS = 20; // 30-bar range floor (flat-market filter)
const SPIKE_MAX_BPS = 60; // last-bar move cap (no chasing wicks)
const STOP_BPS = 120; // -1.2% hard stop from cost
const TRAIL_ARM_BPS = 100; // arm the trailing stop once +1.0% in profit
const TRAIL_BPS = 150; // exit 1.5% below the peak close since entry
const TAKE_BPS = 450; // +4.5% take-profit from cost
const MAX_HOLD_BARS = 240; // 4h time stop
const COOLDOWN_BARS = 10;
const STOP_COOLDOWN_BARS = 60; // after a stop-loss exit, wait longer
const MAX_SLIPPAGE_BPS = 100;

// --- washout backup leg (slow-grind days only) ---
const WASH_LOOKBACK = 360; // six hours of one-minute bars
const WASH_DROP_BPS = 500; // entry needs a 5.0% fall over the lookback
const WASH_NEAR_BPS = 50; // ... and the close within 0.5% of the lookback low
const WASH_STAB_BARS = 3; // ... and the close no lower than 3 bars ago
const WASH_GATE60_BPS = 180; // ... and the 60-min fall NOT sharper than -180
//   bps (the sharp case is the main leg's; the gate makes the two
//   triggers mutually exclusive on any one bar)
const WASH_TP_NUM = 1045; // washout take-profit: +4.5% over the entry's
const WASH_TP_DEN = 1000; //   DECISION close (a price target)
const WASH_TRAIL_NUM = 98; // washout trailing stop: 2.0% below peak value
const WASH_TRAIL_DEN = 100;
const WASH_STOP_NUM = 985; // washout hard stop: 1.5% below cost
const WASH_STOP_DEN = 1000;
const WASH_HOLD_BARS = 1440; // washout time stop (the window is 1440 bars)
const WASH_MAX_ENTRIES = 1; // at most one washout leg per window

type Leg = 'dip' | 'wash' | null;

interface Series {
  closes: bigint[]; // harness price units (1e5 scale), oldest first
  highs: bigint[];
  lows: bigint[];
  entrySeq: number;
  peakClose: bigint;
  peakValue: bigint;
  leg: Leg;
  tpPrice: bigint;
  washEntries: number;
  lastExitSeq: number;
  lastStopSeq: number;
}

function newSeries(): Series {
  return {
    closes: [],
    highs: [],
    lows: [],
    entrySeq: -1,
    peakClose: 0n,
    peakValue: 0n,
    leg: null,
    tpPrice: 0n,
    washEntries: 0,
    lastExitSeq: -1_000_000,
    lastStopSeq: -1_000_000,
  };
}

// Floor division for bigints (JS / truncates toward zero; the tuner
// floors, and the two differ by 1 bp on negative fractional returns).
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b === 0n || (a >= 0n) === (b >= 0n) ? q : q - 1n;
}

// Return over the last n bars in bps, floored, or null when too few bars.
function returnBps(s: Series, n: number): bigint | null {
  const len = s.closes.length;
  if (len <= n) return null;
  const now = s.closes[len - 1];
  const then = s.closes[len - 1 - n];
  if (then <= 0n) return null;
  return floorDiv((now - then) * 10_000n, then);
}

function rangeBps(s: Series, n: number): bigint {
  const len = s.highs.length;
  if (len < 2) return 0n;
  const from = Math.max(0, len - n);
  let hi = -1n;
  let lo = -1n;
  for (let i = from; i < len; i++) {
    if (hi < 0n || s.highs[i] > hi) hi = s.highs[i];
    if (lo < 0n || s.lows[i] < lo) lo = s.lows[i];
  }
  const last = s.closes[len - 1];
  if (last <= 0n) return 0n;
  return ((hi - lo) * 10_000n) / last;
}

function pushBar(s: Series, bar: Bar): void {
  s.closes.push(BigInt(bar.c));
  s.highs.push(BigInt(bar.h));
  s.lows.push(BigInt(bar.l));
  if (s.closes.length > 400) {
    s.closes.shift();
    s.highs.shift();
    s.lows.shift();
  }
}

const series = newSeries();

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) pushBar(series, bar);
    }
    if (state.warmingUp) return [];

    const close = state.close(SYMBOL);
    if (close === null) return [];
    const closeUnits = BigInt(close);
    const held = state.positions.get(SYMBOL);
    const { caps, fees } = state.hello;
    const orders: (SellInput | BuyInput)[] = [];

    // ---- exits, while holding ----
    if (held !== undefined) {
      if (closeUnits > series.peakClose) series.peakClose = closeUnits;
      const value = state.value(SYMBOL, held.qty);
      if (value > series.peakValue) series.peakValue = value;
      const cost = held.cost;
      const heldBars = series.entrySeq >= 0 ? state.seq - series.entrySeq : 0;
      let exit = false;
      let stopLoss = false;
      if (series.leg === 'wash') {
        // Washout leg exits: price-target take-profit, value-based
        // trailing stop and hard stop, long time stop.
        const takeProfit = closeUnits >= series.tpPrice;
        const trailing = value * BigInt(WASH_TRAIL_DEN) <= series.peakValue * BigInt(WASH_TRAIL_NUM);
        stopLoss = value * BigInt(WASH_STOP_DEN) <= cost * BigInt(WASH_STOP_NUM);
        const timeStop = heldBars >= WASH_HOLD_BARS;
        exit = takeProfit || trailing || stopLoss || timeStop;
      } else {
        // Dip leg exits: value-based take-profit and hard stop, close-based
        // trailing stop once in profit, short time stop.
        // Gain formula: truncating integer division, exactly as graded.
        const gainBps = cost > 0n ? Number(((value - cost) * 10_000n) / cost) : 0;
        const peakDropBps =
          series.peakClose > 0n
            ? Number(floorDiv((series.peakClose - closeUnits) * 10_000n, series.peakClose))
            : 0;
        const armed = gainBps >= TRAIL_ARM_BPS;
        stopLoss = gainBps <= -STOP_BPS;
        const takeProfit = gainBps >= TAKE_BPS;
        const trailing = armed && peakDropBps >= TRAIL_BPS;
        const timeStop = heldBars >= MAX_HOLD_BARS;
        exit = stopLoss || takeProfit || trailing || timeStop;
      }
      if (exit) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        series.lastExitSeq = state.seq;
        if (stopLoss) series.lastStopSeq = state.seq;
        series.entrySeq = -1;
        series.peakClose = 0n;
        series.peakValue = 0n;
        series.leg = null;
        series.tpPrice = 0n;
        return orders.slice(0, caps.max_orders_per_bar);
      }
      return [];
    }

    // ---- entries ----
    if (state.seq - series.lastExitSeq < COOLDOWN_BARS) return [];

    const ret15 = returnBps(series, 15);
    const ret60 = returnBps(series, 60);

    // Washout backup entry: a climactic slow selloff that has paused at
    // its low. Gated to non-sharp 60-min falls so it can never pre-empt
    // the main dip leg (the two are mutually exclusive on any one bar).
    if (
      series.washEntries < WASH_MAX_ENTRIES &&
      series.closes.length > WASH_LOOKBACK &&
      ret60 !== null &&
      ret60 >= BigInt(-WASH_GATE60_BPS) &&
      state.seq - series.lastStopSeq >= STOP_COOLDOWN_BARS
    ) {
      const len = series.closes.length;
      const old = series.closes[len - 1 - WASH_LOOKBACK];
      let low = series.closes[len - 1];
      for (let i = len - WASH_LOOKBACK; i < len; i++) {
        if (series.closes[i] < low) low = series.closes[i];
      }
      const stab = series.closes[len - 1 - WASH_STAB_BARS];
      const washedOut = closeUnits * 10_000n <= old * BigInt(10_000 - WASH_DROP_BPS);
      const nearLow = closeUnits * 10_000n <= low * BigInt(10_000 + WASH_NEAR_BPS);
      const paused = closeUnits >= stab;
      if (washedOut && nearLow && paused) {
        const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
        let slice = state.cash;
        if (slice > byWeight) slice = byWeight;
        if (slice < BigInt(fees.min_notional_quote_units)) return [];
        const impact = state.impactBps(SYMBOL, slice);
        if (impact !== null && impact > 30n) return [];
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
        series.entrySeq = state.seq;
        series.peakClose = closeUnits;
        series.peakValue = 0n;
        series.leg = 'wash';
        series.tpPrice = (closeUnits * BigInt(WASH_TP_NUM)) / BigInt(WASH_TP_DEN);
        series.washEntries += 1;
        return orders.slice(0, caps.max_orders_per_bar);
      }
    }

    // Deep-dip mean reversion: a large 60-min drop that has paused
    // (last 15 min clearly positive). No regime gate: the dip is the point.
    // After a stop-loss exit, wait longer before buying another dip.
    // Volatility filter: not dead flat, no chasing a violent wick.
    const lastMove = returnBps(series, 1);
    const flatEnough = rangeBps(series, 30) >= BigInt(RANGE_MIN_BPS);
    const calmLastBar =
      lastMove !== null &&
      lastMove <= BigInt(SPIKE_MAX_BPS) &&
      lastMove >= -BigInt(SPIKE_MAX_BPS);
    if (
      flatEnough &&
      calmLastBar &&
      ret60 !== null &&
      ret60 <= BigInt(-DIP_BPS) &&
      ret15 !== null &&
      ret15 >= BigInt(DIP_TURN_BPS) &&
      state.seq - series.lastStopSeq >= STOP_COOLDOWN_BARS
    ) {
      const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
      let slice = state.cash;
      if (slice > byWeight) slice = byWeight;
      if (slice < BigInt(fees.min_notional_quote_units)) return [];
      // Skip if the pool is too thin for this size at the latest close depth.
      const impact = state.impactBps(SYMBOL, slice);
      if (impact !== null && impact > 30n) return [];
      orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      series.entrySeq = state.seq;
      series.peakClose = closeUnits;
      series.peakValue = 0n;
      series.leg = 'dip';
      series.tpPrice = 0n;
      return orders.slice(0, caps.max_orders_per_bar);
    }
    return [];
  },
});
