# Sentinel v2 — selective deep-dip long-only cbBTC bot

Entry for make.fun `btc-race-24h-20261115-0828` — race a BTC trading bot
live for 24 hours ($250, top 10 paid).

Revision of round 1 ("Sentinel", dev +$24.57, 4 trades).

## Idea

Cash earns nothing and a full-size round trip costs ~26 bps in fees,
slippage and price impact, so this bot sits out most of the day and only
buys two patterns, both sharp-drop mean reversion:

- **Main leg — deep dip:** 60-min return <= -180 bps and the drop has
  paused (15-min return >= +20 bps). Size 100% of cash. Exits: +4.5%
  take-profit, -1.2% hard stop, 1.5% trailing stop below the peak close
  (armed at +1.0%), 240-bar time stop.
- **Backup leg — washout (slow-grind days only):** -5.0% over 360 bars,
  close within 0.5% of the 360-bar low, paused 3 bars, and the 60-min
  return above -180 bps (a slow grind, not a sharp drop). Exits: +4.5%
  price-target take-profit, 2.0% trailing stop on value, -1.5% hard
  stop, 1440-bar time stop. At most one washout leg per window.

Cooldown: 10 bars after any exit; 60 bars after a stop-loss exit.

## Why these numbers

The dev window is a choppy down day (-4% with two -2.5% legs and one
-7.9% capitulation). Trend-following and momentum entries lose there;
only sharp-drop mean reversion profits. Round 1's -120 bps trigger also
bought the hour-13 dip, which fell a further -3% and stopped out (-$9);
-180 bps skips it and only buys the hour-16/17 capitulation at the turn
bar. The recovery runs to $65,480, so a +4.5% take-profit sells at the
peak close where +4.0% sold $470 early. The washout backup never fires
on the dev window (whenever the 360-min fall reaches -5%, the 60-min
fall is already past -180 bps) — it exists for a grindy race day, when
the main leg cannot fire at all.

## Measured

Dev window, exact local replay of the harness (fee 4 bps, slippage
2 bps, fill at the next bar's open against the pool depth):

- buy bar 1046 @ $62,455.57, sell bar 1113 @ $65,341.14
- **net PnL +$45.36 USDC, 2 trades, max drawdown 0.47%**

Robustness (one parameter at a time): dip 170-190 bps, turn 10-30 bps
and take-profit 4.25-4.75% all give +$45.36; dip 150 gives +$28.37,
dip 200 and turn 40 never fire, take-profit 4.0% gives +$39.54.

## Determinism

All bps arithmetic is integer floor division on the harness's own price
units. No randomness, no wall clock, no network, no files.
