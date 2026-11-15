import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// 120m Deep Washout Momentum Reversal Bot - Optimized Revision
// Analyzes Orca Whirlpool 1-minute bars for CBBTC, executes buy and sell orders on batch stream.

const LOOKBACK_WINDOW = 120;
const WASHOUT_BPS = 200;
const PROFIT_TARGET_BPS = 480;
const TRAILING_ACTIVE_BPS = 85;
const TRAILING_DELTA_BPS = 55;
const EMERGENCY_STOP_BPS = 300;
const SLIPPAGE_LIMIT_BPS = 100;

interface TradingMemory {
  historyCloses: number[];
  highWaterMark: number;
  openPrice: number;
  completedTrades: number;
}

const memory: TradingMemory = {
  historyCloses: [],
  highWaterMark: 0,
  openPrice: 0,
  completedTrades: 0,
};

await runBars({
  onHello(barsState: BarsState) {
    memory.historyCloses = [];
    memory.highWaterMark = 0;
    memory.openPrice = 0;
    memory.completedTrades = 0;
  },
  onBatch(barsState: BarsState, batch) {
    const bar = batch.bars.find((b) => b.symbol === 'CBBTC');
    if (!bar) return [];

    const currentClose = Number(bar.c);
    memory.historyCloses.push(currentClose);
    if (memory.historyCloses.length > LOOKBACK_WINDOW * 3) {
      memory.historyCloses.shift();
    }

    const currentPos = barsState.positions.get('CBBTC');
    const sells: SellInput[] = [];
    const buys: BuyInput[] = [];

    if (currentPos && currentPos.qty > 0n) {
      if (currentClose > memory.highWaterMark) {
        memory.highWaterMark = currentClose;
      }
      const entry = memory.openPrice > 0 ? memory.openPrice : Number(currentPos.cost) / (Number(currentPos.qty) / 1e8);
      const profitBps = ((currentClose - entry) / entry) * 10000;
      const retracementBps = ((memory.highWaterMark - currentClose) / memory.highWaterMark) * 10000;

      let shouldExit = false;
      if (profitBps >= PROFIT_TARGET_BPS) {
        shouldExit = true;
      } else if (profitBps >= TRAILING_ACTIVE_BPS && retracementBps >= TRAILING_DELTA_BPS) {
        shouldExit = true;
      } else if (profitBps <= -EMERGENCY_STOP_BPS) {
        shouldExit = true;
      }

      if (shouldExit) {
        sells.push({
          side: 'sell',
          symbol: 'CBBTC',
          qty: currentPos.qty,
          max_slippage_bps: SLIPPAGE_LIMIT_BPS,
        });
        memory.highWaterMark = 0;
        memory.openPrice = 0;
        memory.completedTrades++;
      }
    } else {
      memory.highWaterMark = 0;
      memory.openPrice = 0;

      if (memory.historyCloses.length >= LOOKBACK_WINDOW) {
        const windowSlice = memory.historyCloses.slice(-LOOKBACK_WINDOW);
        const smaVal = windowSlice.reduce((s, v) => s + v, 0) / LOOKBACK_WINDOW;
        const dipBps = ((currentClose - smaVal) / smaVal) * 10000;

        let requiredDipBps = WASHOUT_BPS;
        if (memory.completedTrades === 0 && barsState.seq > 900) {
          requiredDipBps = 115;
        }

        if (dipBps <= -requiredDipBps && barsState.cash >= BigInt(barsState.hello.fees.min_notional_quote_units)) {
          buys.push({
            side: 'buy',
            symbol: 'CBBTC',
            notional_quote_units: barsState.cash,
            max_slippage_bps: SLIPPAGE_LIMIT_BPS,
          });
          memory.openPrice = currentClose;
          memory.highWaterMark = currentClose;
          memory.completedTrades++;
        }
      }
    }

    const orders = [...sells, ...buys].slice(0, barsState.hello.caps.max_orders_per_bar);
    return orders;
  },
});
