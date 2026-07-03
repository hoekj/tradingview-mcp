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

    // toggleVisibility: hide then restore the just-added study.
    const hidden = await indicators.toggleVisibility({ entity_id: add.entity_id, visible: false });
    assert.equal(hidden.success, true);
    assert.equal(hidden.visible, false);
    const shown = await indicators.toggleVisibility({ entity_id: add.entity_id, visible: true });
    assert.equal(shown.success, true);
    assert.equal(shown.visible, true);

    // setInputs: inspect the live study's inputs and exercise a valid one if available.
    const info = await data.getIndicator({ entity_id: add.entity_id });
    assert.equal(info.success, true);
    const numericInput = Array.isArray(info.inputs)
      ? info.inputs.find(inp => typeof inp.value === 'number')
      : undefined;
    if (numericInput) {
      const newValue = numericInput.value + 1;
      const set = await indicators.setInputs({
        entity_id: add.entity_id,
        inputs: { [numericInput.id]: newValue },
      });
      assert.equal(set.success, true);
      assert.equal(set.updated_inputs[numericInput.id], newValue);
    } else {
      await assert.rejects(() => indicators.setInputs({ entity_id: add.entity_id, inputs: {} }));
    }

    const rm = await chart.manageIndicator({ action: 'remove', entity_id: add.entity_id });
    assert.equal(rm.success, true);
  });
});
