// Pump.fun Paper Sprint entry: a pullback lottery bot on the agent-fun/replay/v2 harness.
//
// The bot reads the hello, answers every batch with the orders decided on that
// batch's slot, and stops at done. The strategy lives in strategy.ts; this file
// only wires it into the SDK shim's runBot loop.

import { runBot } from './vendor/makefun-bot.ts';
import { createPullbackBot } from './strategy.ts';

await runBot(createPullbackBot());
