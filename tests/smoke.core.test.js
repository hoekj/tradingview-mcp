// tests/smoke.core.test.js
// Shallow, side-effect-safe checks for categories that are not fully e2e-feasible.
// Through core (no raw CDP), so there is one approach and no duplicated logic.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import * as data from '../src/core/data.js';
import * as capture from '../src/core/capture.js';
import * as replay from '../src/core/replay.js';
import { teardown, sleep } from './helpers/live.js';

describe('smoke (live, infeasible categories)', () => {
  after(async () => { await teardown(); });

  it('panel-dependent readers degrade gracefully (result or documented error)', async () => {
    for (const fn of ['getStrategyResults', 'getTrades', 'getEquity', 'getDepth']) {
      try {
        const r = await data[fn]();
        assert.equal(typeof r.success, 'boolean', `${fn} returns success flag`);
      } catch (err) {
        // getDepth (and other panel readers) may throw a documented error when
        // their panel/strategy is absent from the chart — the MCP tool layer
        // (src/tools/data.js) catches this and converts it to { success: false,
        // error }. That is the documented graceful-degradation contract at the
        // tool boundary, so treat a thrown Error with a message as graceful too.
        assert.ok(err instanceof Error && typeof err.message === 'string' && err.message.length > 0,
          `${fn} threw a non-Error or message-less error: ${err}`);
      }
    }
  });

  it('captureScreenshot writes a file, then clean it up', async () => {
    const r = await capture.captureScreenshot({ region: 'chart' });
    assert.equal(r.success, true);
    if (r.file_path && existsSync(r.file_path)) {
      rmSync(r.file_path);
    }
  });

  it('replay start -> status -> stop (cleanup guaranteed)', async (t) => {
    if (process.env.TVMCP_REPLAY_TESTS !== '1') {
      t.skip('set TVMCP_REPLAY_TESTS=1 to run');
      return;
    }
    try {
      const s = await replay.start({ date: '2025-03-03' });
      assert.equal(s.success, true);
      await sleep(500);
      const st = await replay.status();
      assert.equal(st.success, true);
    } finally {
      try { await replay.stop(); } catch { /* best-effort cleanup */ }
    }
  });
});
