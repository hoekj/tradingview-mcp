import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/screener.js';

export function registerScreenerTools(server) {
  // Dismiss any overlay left open by an unexpected error.
  async function escapeRecover() {
    try {
      const { getClient } = await import('../connection.js');
      const c = await getClient();
      await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    } catch (_) {}
  }

  server.tool('screener_get_rows',
    'Make the named saved screen the active screener and return its rows as EXCH:TICKER[]. Omit screenName to scrape the currently active screen. Fails loudly if the screen is missing or the name is ambiguous. If `stale:true` is set, the row set was never confirmed to have finished rendering — ignore `complete` when it is set.',
    {
      screenName: z.string().optional().describe('Exact saved screen name, e.g. "Pre-market most active". Omit to use the active screen.'),
    },
    async ({ screenName }) => {
      try { return jsonResult(await core.get({ screenName })); }
      catch (err) { await escapeRecover(); return jsonResult({ success: false, error: err.message }, true); }
    });
}
