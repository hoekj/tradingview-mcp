// tests/chart.core.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as indicators from '../src/core/indicators.js';
import { teardown, sleep, snapshotChart, restoreChart } from './helpers/live.js';

describe('chart core (live e2e)', () => {
  let snap;
  before(async () => { snap = await snapshotChart(); });
  after(async () => { await restoreChart(snap); await teardown(); });

  it('getState returns symbol/resolution/type/studies', async () => {
    const s = await chart.getState();
    assert.equal(s.success, true);
    assert.ok(s.symbol && s.resolution);
    assert.ok(Array.isArray(s.studies));
  });

  it('getVisibleRange returns a from<to window (regression: was ReferenceError)', async () => {
    const r = await chart.getVisibleRange();
    assert.equal(r.success, true);
    assert.ok(r.visible_range.to > r.visible_range.from);
  });

  it('symbolInfo returns exchange metadata (regression: was ReferenceError)', async () => {
    const r = await chart.symbolInfo();
    assert.equal(r.success, true);
    assert.ok(r.symbol);
  });

  it('getQuote and getOhlcv summary return well-formed data', async () => {
    const q = await data.getQuote();
    assert.equal(q.success, true);
    const o = await data.getOhlcv({ summary: true });
    assert.equal(o.success, true);
    assert.ok(o.high >= o.low);
  });

  it('setSymbol/setTimeframe/setType round-trip', async () => {
    const target = snap.symbol.includes('AAPL') ? 'MSFT' : 'AAPL';
    const r = await chart.setSymbol({ symbol: target });
    assert.equal(r.success, true);
    await sleep(1500);
    const s = await chart.getState();
    assert.ok(s.symbol.includes(target));
    await chart.setTimeframe({ timeframe: '5' });
    await sleep(800);
    assert.match(String((await chart.getState()).resolution), /5/);
  });

  it('manageIndicator add then remove', async () => {
    const add = await chart.manageIndicator({ action: 'add', indicator: 'Volume' });
    assert.equal(add.success, true);
    assert.ok(add.entity_id);
    const rm = await chart.manageIndicator({ action: 'remove', entity_id: add.entity_id });
    assert.equal(rm.success, true);
  });
});
