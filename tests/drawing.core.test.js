// tests/drawing.core.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as drawing from '../src/core/drawing.js';
import * as data from '../src/core/data.js';
import { teardown, sleep } from './helpers/live.js';

describe('drawing core (live e2e)', () => {
  // Safety guard: never run destructive draw/clear tests against a chart that
  // already has user drawings on it. Snapshot the pre-existing count once,
  // up front, and skip the destructive tests if it is non-zero.
  let preExistingCount = null;

  before(async () => {
    const list = await drawing.listDrawings();
    preExistingCount = list.count;
  });

  after(async () => {
    // Only clear if we know the chart started empty (i.e. we are the ones
    // who may have left something behind); never clearAll a chart that had
    // pre-existing shapes.
    if (preExistingCount === 0) {
      try { await drawing.clearAll(); } catch { /* best-effort cleanup */ }
    }
    await teardown();
  });

  it('draw -> list -> getProperties -> removeOne', async (t) => {
    if (preExistingCount > 0) {
      t.skip(`chart already has ${preExistingCount} drawing(s); skipping destructive test to avoid clobbering user drawings`);
      return;
    }

    const bars = await data.getOhlcv({ count: 5 });
    const last = bars.bars[bars.bars.length - 1];
    const created = await drawing.drawShape({ shape: 'horizontal_line', point: { time: last.time, price: last.close } });
    assert.equal(created.success, true);
    assert.ok(created.entity_id, 'shape created with id');

    const list = await drawing.listDrawings();
    assert.equal(list.success, true);
    assert.ok(list.shapes.some(s => s.id === created.entity_id), 'shape present in list (regression: was ReferenceError)');

    const props = await drawing.getProperties({ entity_id: created.entity_id });
    assert.equal(props.success, true);

    const rm = await drawing.removeOne({ entity_id: created.entity_id });
    assert.equal(rm.removed, true);
  });

  it('clearAll removes everything', async (t) => {
    if (preExistingCount > 0) {
      t.skip(`chart already has ${preExistingCount} drawing(s); skipping destructive test to avoid clobbering user drawings`);
      return;
    }

    const bars = await data.getOhlcv({ count: 5 });
    const last = bars.bars[bars.bars.length - 1];
    await drawing.drawShape({ shape: 'horizontal_line', point: { time: last.time, price: last.high } });
    await sleep(300);
    const r = await drawing.clearAll();
    assert.equal(r.success, true);
    const list = await drawing.listDrawings();
    assert.equal(list.count, 0);
  });
});
