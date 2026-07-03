import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { listDrawings, removeOne, clearAll } from '../src/core/drawing.js';

describe('drawing.js binds evaluate/getChartApi via _resolve (regression)', () => {
  it('listDrawings returns shaped result', async () => {
    const d = { evaluate: async () => [{ id: 'a', name: 'Line' }], getChartApi: async () => 'CHART' };
    const r = await listDrawings({ _deps: d });
    assert.equal(r.success, true);
    assert.equal(r.count, 1);
  });

  it('clearAll returns shaped result', async () => {
    const d = { evaluate: async () => undefined, getChartApi: async () => 'CHART' };
    const r = await clearAll({ _deps: d });
    assert.equal(r.success, true);
    assert.equal(r.action, 'all_shapes_removed');
  });

  it('removeOne returns removed flag', async () => {
    const d = { evaluate: async () => ({ removed: true, entity_id: 'x', remaining_shapes: 0 }), getChartApi: async () => 'CHART' };
    const r = await removeOne({ entity_id: 'x', _deps: d });
    assert.equal(r.success, true);
    assert.equal(r.removed, true);
  });
});
