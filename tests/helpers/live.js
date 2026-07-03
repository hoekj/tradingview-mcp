// tests/helpers/live.js
import { disconnect } from '../../src/connection.js';
import * as chart from '../../src/core/chart.js';

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Close the shared CDP socket so `node --test` can exit.
export async function teardown() {
  await disconnect();
}

// Capture symbol/timeframe/type so a suite can restore chart state it mutates.
export async function snapshotChart() {
  const s = await chart.getState();
  return { symbol: s.symbol, resolution: s.resolution, chartType: s.chartType };
}

export async function restoreChart(snap) {
  if (!snap) return;
  await chart.setSymbol({ symbol: snap.symbol });
  await sleep(1500);
  await chart.setTimeframe({ timeframe: String(snap.resolution) });
  await sleep(800);
  await chart.setType({ chart_type: snap.chartType });
  await sleep(400);
}

// Pick a real ticker not already present (so we never clobber user state).
export function pickAbsentSymbol(presentSet, candidates = ['AAPL', 'MSFT', 'KO', 'F', 'T', 'INTC']) {
  return candidates.find(c => !presentSet.has(c.toUpperCase()));
}
