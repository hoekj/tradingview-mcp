// tests/alerts.core.test.js
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as alerts from '../src/core/alerts.js';
import * as data from '../src/core/data.js';
import { teardown, sleep } from './helpers/live.js';

describe('alerts core (live e2e, env-gated)', () => {
  after(async () => { await teardown(); });

  it('create -> list -> deleteAll', async (t) => {
    if (process.env.TVMCP_ALERT_TESTS !== '1') { t.skip('set TVMCP_ALERT_TESTS=1 to run (creates real alerts)'); return; }

    // Safety guard: deleteAlerts({ delete_all: true }) wipes EVERY alert on the
    // account, not just the one this test creates. Only proceed if the account
    // currently has zero alerts, so cleanup cannot destroy pre-existing user data.
    const existing = await alerts.list();
    const existingCount = existing?.alert_count ?? (Array.isArray(existing?.alerts) ? existing.alerts.length : 0);
    if (existingCount > 0) {
      t.skip('skipped: account has pre-existing alerts; delete_all cleanup would wipe them');
      return;
    }

    const q = await data.getQuote();
    const price = Number(q.close || q.last);
    try {
      const c = await alerts.create({ condition: 'crossing', price: (price * 1.5).toFixed(2), message: 'zz_e2e_alert' });
      assert.equal(c.success, true);
      await sleep(800);
      const l = await alerts.list();
      assert.equal(l.success, true);
      assert.ok(Array.isArray(l.alerts));
    } finally {
      try { await alerts.deleteAlerts({ delete_all: true }); } catch {}
    }
  });
});
