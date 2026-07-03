import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getVisibleRange, symbolInfo, scrollToDate } from '../src/core/chart.js';

// A mock _deps whose evaluate returns canned values for any expression.
function mockDeps(map) {
  return { _deps: { evaluate: async (expr) => {
    for (const [needle, val] of map) { if (expr.includes(needle)) return val; }
    return null;
  } } };
}

describe('chart.js binds evaluate via _resolve (regression: ReferenceError)', () => {
  it('getVisibleRange returns shaped result with injected deps', async () => {
    const r = await getVisibleRange(mockDeps([['getVisibleRange', { visible_range: { from: 1, to: 2 }, bars_range: { from: 0, to: 9 } }]]));
    assert.equal(r.success, true);
    assert.deepEqual(r.visible_range, { from: 1, to: 2 });
  });

  it('symbolInfo returns shaped result with injected deps', async () => {
    const r = await symbolInfo(mockDeps([['symbolExt', { symbol: 'AAPL', exchange: 'NASDAQ' }]]));
    assert.equal(r.success, true);
    assert.equal(r.symbol, 'AAPL');
  });

  it('scrollToDate resolves without ReferenceError', async () => {
    const r = await scrollToDate({ date: '2025-01-15', _deps: { evaluate: async () => 'D' } });
    assert.equal(r.success, true);
    assert.equal(r.date, '2025-01-15');
  });
});
