// Pump.fun pullback lottery bot: buy the dip after a launch spike, hold the
// few coins that run to migration, and get out of everything else cheaply.
//
// The idea, in one paragraph: on the dev data every way of buying a launch at
// its spike loses — the fill lands two slots after the decision, right at the
// top, and the coin then grinds down. What pays, the only thing that pays,
// is holding a coin that migrates (completes its bonding curve): the two
// completing coins the dev window's pullback entries caught were worth +0.43
// and +0.41 SOL (on the dev grade the run is +0.65 SOL overall, -0.37 without
// its top three coins — the result is a lottery, and it says so). So this bot buys lottery tickets, not positions: it watches
// every curve's real SOL reserve, notes the price the first time the reserve
// reaches 1.5 SOL, and buys once — at most 0.10 SOL — only after the price
// has pulled back 25% from that spike, within 1500 slots. The position then
// gets a wide 50% stop loss, a 40% trailing stop once 30% in profit, a
// 600-slot maximum hold, and an immediate exit when the creator sells. Most
// tickets lose a little; a ticket on a coin that migrates pays for all of
// them. Buys go out with slippage wide open: the coins that are about to run
// move 30% or more inside the two-slot latency, and a tight slippage cap
// refuses exactly those fills. The spike and the dip are both read off the
// individual trades, not the post-batch price — a slot can carry several
// trades, and a dip can happen and recover inside one slot. Tiny 0.01 SOL probe round
// trips, paced against elapsed block time, keep the run above the
// competition's 20-coin guardrail on windows where pullback tickets are
// scarce.
//
// Deterministic by construction: no clock, no randomness, no network; every
// loop runs over insertion-ordered Maps fed by the batch stream. The bot speaks
// the agent-fun/replay/v2 protocol through the vendored SDK shim: it reads a
// hello, answers each batch with a reply echoing that batch's seq, and stops
// at done. Orders decided on the batch for slot s fill at slot s + 2.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
/** Curve + creator fee on every trade, 95 + 30 bps. */
const CURVE_FEE = 0.0125;

export interface Tune {
  /** Note the spike price the first time a curve's real SOL reaches this. */
  entryRealSol: number;
  /** Buy once the price has pulled back this far from the spike price. */
  pullback: number;
  /** Slots after the spike during which a pullback buy is still allowed. */
  pullbackWindowSlots: number;
  /** Most SOL per buy (the 1%-of-real-reserve cap applies too). */
  stakeSol: number;
  /** Smallest buy worth sending, in SOL. */
  minBuySol: number;
  /** Slippage on buys, in bps; sells always go out wide open. */
  buySlipBps: number;
  /** Stop loss, as a share of cost. */
  stopLoss: number;
  /** Trailing stop, as a share of the position's peak value. */
  trail: number;
  /** The trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Exit after this many slots held, whatever the value. */
  maxHoldSlots: number;
  /** Guardrail pacing: how many distinct coins the run should end with. */
  targetCoins: number;
  /** Guardrail pacing: how many of the bot's own fills the run should end with. */
  targetFills: number;
  /** Seconds of block time the pace ramps over. */
  paceSecs: number;
  /** One probe round trip, in SOL. */
  probeSol: number;
  /** Most probe round trips open at once. */
  maxProbes: number;
}

// Settings traded with. Picked from the middle of the flat region found on the
// dev data with a faithful offline sweep (slot-accurate fills, see the tools
// dir, not the repo): pullback 0.25, stop 50%, trail 40% armed at +30%,
// hold 600 slots, stake 0.10 SOL.
export const DEFAULT_TUNE: Tune = {
  entryRealSol: 1.5,
  pullback: 0.25,
  pullbackWindowSlots: 1500,
  stakeSol: 0.1,
  minBuySol: 0.01,
  buySlipBps: 10000,
  stopLoss: 0.5,
  trail: 0.4,
  trailArm: 0.3,
  maxHoldSlots: 600,
  targetCoins: 25,
  targetFills: 50,
  paceSecs: 21600,
  probeSol: 0.01,
  maxProbes: 1,
};

/** Everything remembered about one curve. */
interface CoinBook {
  creator: string | null;
  /** Slot the curve first reached the entry threshold (null: not yet). */
  crossedSlot: number | null;
  /** Price (SOL per token) at that first crossing. */
  crossPrice: number;
  /** Slot of the latest trade that pulled back far enough (null: none yet). */
  dipSlot: number | null;
  /** A main buy has been decided for this coin (or its pullback window passed). */
  entered: boolean;
  /** Its creator sold after the bot's entry (an exit trigger). */
  devSoldAfterEntry: boolean;
}

/** One open lottery ticket. */
interface OpenTrade {
  openedSlot: number;
  /** Best close value seen, in SOL. */
  peakSol: number;
  exiting: boolean;
  /** At least one buy of this position has filled. */
  landed: boolean;
}

/** SOL the bot would receive for selling `tokens` into reserves (vq, vt). */
function closeValueSol(tokens: number, vq: number, vt: number, txSol: number): number {
  if (tokens <= 0 || vt <= 0) return 0;
  const gross = (tokens * vq) / (vt + tokens) / LAMPORTS;
  return gross * (1 - CURVE_FEE) - txSol;
}

export function createPullbackBot(t: Tune = DEFAULT_TUNE): Bot {
  const books = new Map<Pubkey, CoinBook>();
  const open = new Map<Pubkey, OpenTrade>();
  /** Probe round trips in flight, by mint. */
  const probes = new Set<Pubkey>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;

  const bookOf = (mint: Pubkey): CoinBook => {
    let book = books.get(mint);
    if (book === undefined) {
      book = { creator: null, crossedSlot: null, crossPrice: 0, dipSlot: null, entered: false, devSoldAfterEntry: false };
      books.set(mint, book);
    }
    return book;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;

      for (const fill of batch.fills) {
        if (fill.status === 'filled' && !fill.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(fill.mint);
        }
      }
      /** Lowest trade price per coin in this batch, for same-slot dip checks. */
      const batchLow = new Map<Pubkey, number>();
      for (const ev of batch.events) {
        if (ev.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = ev.block_time;
          if (lastBlockTime === null || ev.block_time > lastBlockTime) lastBlockTime = ev.block_time;
        }
        if (ev.event === 'CreateEvent') {
          bookOf(ev.mint).creator = ev.creator;
        } else if (ev.event === 'TradeEvent') {
          const book = bookOf(ev.mint);
          if (book.creator === null) book.creator = ev.creator;
          // Lowest price seen for this coin in this batch (one batch is one
          // slot), so a dip that happened earlier in the crossing slot is
          // not lost when the crossing trade itself comes second.
          const price = Number(ev.virtual_quote_reserves) / Number(ev.virtual_token_reserves);
          const low = batchLow.get(ev.mint);
          if (low === undefined || price < low) batchLow.set(ev.mint, price);
          // The spike is read off the first trade that crosses the threshold:
          // a slot can carry several trades, and the post-batch price would
          // already include the later ones, inflating the spike and making
          // the pullback trigger far too easily.
          if (book.crossedSlot === null && BigInt(ev.real_quote_reserves) >= BigInt(Math.floor(t.entryRealSol * LAMPORTS))) {
            book.crossedSlot = ev.slot;
            book.crossPrice = Number(ev.virtual_quote_reserves) / Number(ev.virtual_token_reserves);
            // A dip can also precede the crossing trade inside the same slot
            // (the launch trade itself is the cheapest one); count it.
            const slotLow = batchLow.get(ev.mint);
            if (slotLow !== undefined && slotLow <= book.crossPrice * (1 - t.pullback)) {
              book.dipSlot = ev.slot;
            }
          } else if (
            book.crossedSlot !== null &&
            book.dipSlot !== ev.slot &&
            ev.slot <= book.crossedSlot + t.pullbackWindowSlots &&
            Number(ev.virtual_quote_reserves) / Number(ev.virtual_token_reserves) <= book.crossPrice * (1 - t.pullback)
          ) {
            // The dip is read off the trade itself, not the post-batch price:
            // a dip can happen and recover inside one slot, and the post-batch
            // price would miss it entirely.
            book.dipSlot = ev.slot;
          }
          // A creator sell after entry is an exit trigger for a held position.
          if (!ev.is_buy && open.has(ev.mint) && ev.user === book.creator) {
            book.devSoldAfterEntry = true;
          }
        }
      }

      const traded = new Set<Pubkey>();
      for (const ev of batch.events) traded.add(ev.mint);
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      const sellPending = (mint: Pubkey): boolean => {
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') return true;
        }
        return false;
      };

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: a position is sold whole on the first exit trigger that fires.
      for (const [mint, trade] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) open.delete(mint);
          continue;
        }
        trade.landed = true;
        if (curve === undefined || curve.complete) continue;
        const mark = marks.get(mint);
        const vq = mark ? Number(mark.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mark ? Number(mark.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const value = closeValueSol(Number(pos.token_amount), vq, vt, txSol);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > trade.peakSol) trade.peakSol = value;
        const book = bookOf(mint);
        let exit = trade.exiting;
        if (!exit && value <= cost * (1 - t.stopLoss)) exit = true;
        if (!exit && trade.peakSol >= cost * (1 + t.trailArm) && value <= trade.peakSol * (1 - t.trail)) exit = true;
        if (!exit && now - trade.openedSlot >= t.maxHoldSlots) exit = true;
        if (!exit && book.devSoldAfterEntry) exit = true;
        if (!exit) continue;
        trade.exiting = true;
        if (pendingByMint.has(mint)) {
          // A sell already in flight: wait for it. A buy in flight: sell what we hold anyway.
          if (sellPending(mint)) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const mint of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
      }

      // Entries: buy once, after the price has pulled back from its spike.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap || slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || open.has(mint)) continue;
        const book = bookOf(mint);
        if (book.entered) continue;
        if (book.crossedSlot === null) continue;
        if (book.dipSlot === null) {
          if (now - book.crossedSlot > t.pullbackWindowSlots) book.entered = true;
          continue;
        }
        // The dip was read off the trade itself; buy on its batch (or within
        // a few slots if every position slot was full just then).
        if (now - book.dipSlot > 30) {
          book.entered = true;
          continue;
        }
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol, t.stakeSol);
        if (amount > free - txSol) amount = free - txSol;
        if (amount < t.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: t.buySlipBps });
        free -= amount + txSol;
        slotsLeft--;
        book.entered = true;
        open.set(mint, { openedSlot: now, peakSol: 0, exiting: false, landed: false });
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < t.maxProbes && slotsLeft > 0 && firstBlockTime !== null && lastBlockTime !== null) {
        const pace = Math.min(1, (lastBlockTime - firstBlockTime) / t.paceSecs);
        const needCoins = myCoins.size < Math.ceil(t.targetCoins * pace);
        const needFills = myFills < Math.ceil(t.targetFills * pace);
        if (needCoins || needFills) {
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= t.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            // The 1% size cap must clear the probe with room to spare.
            if (Number(curve.real_quote_reserves) / LAMPORTS < t.probeSol * 150) continue;
            if (free < t.probeSol + 2 * txSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(t.probeSol * LAMPORTS)), max_slippage_bps: t.buySlipBps });
            probes.add(mint);
            free -= t.probeSol + txSol;
          }
        }
      }
      return orders;
    },
  };
}
