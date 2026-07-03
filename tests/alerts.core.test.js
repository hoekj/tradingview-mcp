// tests/alerts.core.test.js
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as alerts from '../src/core/alerts.js';
import * as data from '../src/core/data.js';
import { teardown, sleep } from './helpers/live.js';

describe('alerts core (live e2e, env-gated)', () => {
  after(async () => { await teardown(); });

  it('create -> list -> delete-own (targeted, safe on any account)', async (t) => {
    if (process.env.TVMCP_ALERT_TESTS !== '1') { t.skip('set TVMCP_ALERT_TESTS=1 to run (creates a real, throwaway alert)'); return; }

    // Unique marker so we can unambiguously identify the alert this test created,
    // never touching any pre-existing alert on the account.
    const marker = `zz_e2e_alert_${Date.now()}`;

    const baseline = await alerts.list();
    assert.equal(baseline.success, true);
    const baselineIds = new Set((baseline.alerts || []).map(a => a.alert_id));

    let throwawayId;
    try {
      const q = await data.getQuote();
      const price = Number(q.close || q.last);
      const c = await alerts.create({ condition: 'crossing', price: (price * 1.5).toFixed(2), message: marker });
      assert.equal(c.success, true);
      await sleep(800);

      const afterCreate = await alerts.list();
      assert.equal(afterCreate.success, true);
      assert.ok(Array.isArray(afterCreate.alerts));

      // Identify the throwaway: an alert whose name (or message, as a fallback)
      // matches our marker, and whose id was NOT present in the baseline snapshot.
      // The "message" passed to alerts.create() is set as the alert's "name" field
      // in TradingView's API — list_alerts returns it separately from "message"
      // (which stays as the auto-generated condition summary, e.g. "T Crossing 20.59").
      const candidate = (afterCreate.alerts || []).find(a => {
        if (baselineIds.has(a.alert_id)) return false;
        if (typeof a.name === 'string' && a.name.includes(marker)) return true;
        if (typeof a.message === 'string' && a.message.includes(marker)) return true;
        return false;
      });
      assert.ok(candidate, `expected to find a new alert with name/message containing "${marker}"`);
      throwawayId = candidate.alert_id;

      const del = await alerts.deleteAlerts({ alert_id: throwawayId });
      assert.equal(del.success, true);
      await sleep(800);

      const afterDelete = await alerts.list();
      assert.equal(afterDelete.success, true);
      const afterDeleteIds = new Set((afterDelete.alerts || []).map(a => a.alert_id));

      // The throwaway is gone.
      assert.equal(afterDeleteIds.has(throwawayId), false, 'throwaway alert should have been deleted');

      // Every baseline alert is still present — the account was not otherwise disturbed.
      for (const id of baselineIds) {
        assert.equal(afterDeleteIds.has(id), true, `baseline alert ${id} must still exist`);
      }

      throwawayId = undefined; // cleanup succeeded, nothing left to remove in finally
    } finally {
      // Safety net: if the throwaway alert is still around for any reason,
      // remove it by its own id. Never delete_all here.
      if (throwawayId !== undefined) {
        try { await alerts.deleteAlerts({ alert_id: throwawayId }); } catch {}
      }
    }
  });
});
