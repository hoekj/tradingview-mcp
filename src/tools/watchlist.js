import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/watchlist.js';

export function registerWatchlistTools(server) {
  // Dismiss any open search/input overlay after an error
  async function escapeRecover() {
    try {
      const { getClient } = await import('../connection.js');
      const c = await getClient();
      await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    } catch (_) {}
  }

  server.tool('watchlist_get', 'Get all symbols from the current TradingView watchlist with last price, change, and change%', {}, async () => {
    try { return jsonResult(await core.get()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_add', 'Add a symbol to the TradingView watchlist', {
    symbol: z.string().describe('Symbol to add (e.g., AAPL, BTCUSD, ES1!, NYMEX:CL1!)'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.add({ symbol })); }
    catch (err) {
      await escapeRecover();
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('watchlist_remove', 'Remove a single symbol from the active TradingView watchlist (idempotent if absent)', {
    symbol: z.string().describe('Symbol to remove (e.g., AAPL, NYSE:NOK)'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.remove({ symbol })); }
    catch (err) { await escapeRecover(); return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_clear', 'Remove all symbols from the active watchlist. If expect_list is given, refuses unless the active list name matches.', {
    expect_list: z.string().optional().describe('Guard: only clear if the active list has this exact name'),
  }, async ({ expect_list }) => {
    try { return jsonResult(await core.clear({ expect_list })); }
    catch (err) { await escapeRecover(); return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_sort', 'Reorder the active watchlist to match the given symbol array. The array must be an exact permutation of the current symbols.', {
    symbols: z.array(z.string()).describe('Desired order — must contain exactly the symbols currently in the list'),
  }, async ({ symbols }) => {
    try { return jsonResult(await core.sort({ symbols })); }
    catch (err) { await escapeRecover(); return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_select', 'Activate a saved watchlist by name (e.g. "Today"). On failure the result lists the available watchlist names.', {
    name: z.string().describe('Exact name of the saved watchlist to activate (case-insensitive)'),
  }, async ({ name }) => {
    try { return jsonResult(await core.select({ name })); }
    catch (err) { await escapeRecover(); return jsonResult({ success: false, error: err.message }, true); }
  });
}
