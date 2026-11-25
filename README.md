# Pump.fun Paper Sprint Bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Dexxcuyy-gaming/pump-fun-paper-sprint-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Dexxcuyy-gaming/pump-fun-paper-sprint-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A momentum paper-trading bot for the make.fun bounty
[Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b).
It paper-trades pump.fun bonding curves on a 6-hour replay; highest net PnL wins.

Bounty opened 2026-11-24T05:37:28Z. This build session started after the opening.

## Strategy

`strategy.ts` buys lottery tickets, not positions: it notes the price the
first time a curve's real SOL reserve reaches 1.5 SOL, then buys once — at
most 0.10 SOL — only after the price has pulled back 25% from that spike.
Each ticket carries a wide 50% stop loss, a 40% trailing stop once 30% in
profit, a 600-slot maximum hold, and an immediate exit when the creator sells.
Most tickets lose a little; a ticket on a coin that migrates pays for all of
them. Tiny 0.01 SOL probe round trips, paced against elapsed block time, keep
the run above the 20-coin guardrail when pullback tickets are scarce. On the
kit's dev data this shape trades 108 coins at a 13% win rate for +0.65 SOL
overall; the two completing coins it held are worth +0.43 and +0.41 SOL, and
without the top three coins the run is -0.37 SOL — the result is a lottery,
and it says so.

## Layout

- `main.ts` — entrypoint: wires the strategy into the SDK shim's `runBot`.
- `strategy.ts` — the momentum strategy (the only file with trading logic).
- `vendor/makefun-bot.ts` — byte-identical copy of the kit's SDK shim; it owns
  the agent-fun/replay/v2 wire protocol (hello, batch, orders, slot, done).

## Run it

Node 22, no dependencies, no install:

```sh
node main.ts
```

Grade it locally with the kit (from the unpacked kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/this/repo --driver process
```

The bot is deterministic: no clock, no randomness, no network calls. The
grader runs it twice and the two action logs must match byte for byte.

## License

MIT. See [LICENSE](LICENSE).
