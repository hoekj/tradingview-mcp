// tests/data.core.test.js
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as data from '../src/core/data.js';
import { teardown } from './helpers/live.js';

describe('data core (live e2e)', () => {
  after(async () => { await teardown(); });

  it('getStudyValues returns a studies array', async () => {
    const r = await data.getStudyValues();
    assert.equal(r.success, true);
    assert.ok(Array.isArray(r.studies));
  });

  it('getOhlcv returns bars', async () => {
    const r = await data.getOhlcv({ count: 20 });
    assert.equal(r.success, true);
    assert.ok(r.bars.length > 0);
  });

  it('pine graphics readers return well-formed (possibly empty) results', async () => {
    for (const fn of ['getPineLines', 'getPineLabels', 'getPineTables', 'getPineBoxes']) {
      const r = await data[fn]();
      assert.equal(r.success, true, `${fn} success`);
      assert.ok(Array.isArray(r.studies), `${fn} studies array`);
    }
  });
});
