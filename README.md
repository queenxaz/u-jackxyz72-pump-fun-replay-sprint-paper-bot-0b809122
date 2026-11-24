[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/queenxaz/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/queenxaz/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Long Rider

A pump.fun paper-trading bot for make.fun's **Pump.fun Replay Sprint — Paper Bot, Real Ranking** bounty ($2 in USDC, 3 places paid: 1st $1, 2nd $0.60, 3rd $0.40).

The bot trades 10 SOL of paper money on a 24-hour replay of pump.fun chain data the house records after entries close. Highest net PnL wins; a placement reward needs a net PnL above holding cash (above 0 after every fee). Paper trading only — no real money, no entry fee.

## Strategy

- **Launch sniper with a rug filter.** Every new bonding curve is watched from its `CreateEvent`. The bot buys only young launches (first 30 slots) that pass the filter: the curve already holds 0.3–30 SOL of real SOL, the creator's own buys are at most 2.5 SOL, at most 5 distinct other wallets have bought in, and the creator has not sold. One buy per coin; each buy is capped at 1% of the curve's real SOL reserve, so early buys are small by construction.
- **Wide take-profit for a 24-hour window.** A position is sold whole on the first of: take-profit (+200%), stop-loss (−30%), a trailing stop (arms at +100%, sells on a 30% pullback from the peak value), or a 40,000-slot time stop. The take-profit is wide on purpose: over 24 hours the rare runner needs room to run to completion, and the trailing stop banks the gain if it turns. Exits are judged on the constant-product sale value of the position — what selling the tokens against the curve would actually pay after the 1.25% curve fee — not on a linear price.
- **No exit on creator selling.** Creators sell small amounts constantly; exiting on every creator sale churns the book into fees. The stop-loss and the time stop do that job instead.
- **Long holds, few round trips.** Fees are ~1.25% a side plus a flat tx fee, so the bot trades rarely and lets the rare runner run.

## Practice result (dev window, `grade-local --driver process`)

- Net PnL **−0.062 SOL** (90% interval −0.344 … +0.226 SOL), 69 round trips over 69 coins, win rate 14%, max drawdown 2.1%.
- Guardrails met: 55 coins hold a round trip of at least 0.01 SOL (bar: 20), drawdown well under the 50% cap.
- For comparison on the same dev window: house equal-weight baseline −0.023 SOL (5 coins, guardrails not met), house momentum pilot −9.45 SOL, house reversion pilot −4.37 SOL, house sniper pilot −0.42 SOL.

## Files

- `main.ts` — the bot (Node 22, `agent-fun/replay/v2`; run by the grader as `node /bot/main.ts`).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte-for-byte from `sdk/ts/makefun-bot.ts`.
- `.makefun/owner.json` — payout wallet.

## Run locally

```sh
node --version  # Node 22.18+ (the grader runs Node 22.23.4)
```

Grade against the kit's dev window with the kit CLI (from the unpacked kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process
```

Deterministic: no clock, no environment reads, no randomness — the bot's decisions come only from the harness batches, so two executions on the same data produce identical action logs.
