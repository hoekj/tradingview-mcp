import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as watchlist from '../src/core/watchlist.js';
import { disconnect } from '../src/connection.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('watchlist core (live e2e)', () => {
  before(async () => {
    // Ensure the watchlist tab is active before the suite runs.
    await watchlist.get();
    await sleep(300);
  });

  // Close the shared CDP websocket so `node --test` can exit instead of hanging.
  after(async () => {
    await disconnect();
  });

  it('get() returns active_list name', async () => {
    const res = await watchlist.get();
    assert.equal(res.success, true, 'get succeeds');
    assert.equal(typeof res.active_list, 'string', 'active_list is a string');
    assert.ok(res.active_list.length > 0, 'active_list is non-empty');
  });

  it('remove() is idempotent for an absent symbol', async () => {
    const res = await watchlist.remove({ symbol: 'ZZZZ_NOT_A_REAL_TICKER' });
    assert.equal(res.success, true, 'absent remove still succeeds');
    assert.equal(res.removed, false, 'nothing was removed');
  });

  it('add() then remove() round-trips a throwaway symbol', async () => {
    const before = await watchlist.get();
    const present = new Set(before.symbols.map(s => watchlist.normalizeSymbol(s.symbol)));
    // Pick a real symbol that is NOT already in the list, so we never clobber the user's.
    const candidates = ['AAPL', 'MSFT', 'KO', 'T', 'F'];
    const testSym = candidates.find(c => !present.has(watchlist.normalizeSymbol(c)));
    assert.ok(testSym, 'found a throwaway symbol not already in the list');

    await watchlist.add({ symbol: testSym });
    await sleep(500);
    const mid = await watchlist.get();
    const midHas = mid.symbols.some(s => watchlist.normalizeSymbol(s.symbol) === watchlist.normalizeSymbol(testSym));
    assert.ok(midHas, `${testSym} present after add`);

    const rem = await watchlist.remove({ symbol: testSym });
    assert.equal(rem.removed, true, `${testSym} removed`);
    await sleep(300);
    const after = await watchlist.get();
    const afterHas = after.symbols.some(s => watchlist.normalizeSymbol(s.symbol) === watchlist.normalizeSymbol(testSym));
    assert.ok(!afterHas, `${testSym} absent after remove`);
  });

  it('clear() refuses when expect_list does not match (non-destructive)', async () => {
    const before = await watchlist.get();
    const wrong = (before.active_list || 'X') + '___WRONG';
    const res = await watchlist.clear({ expect_list: wrong });
    assert.equal(res.success, false, 'clear refuses on mismatch');
    assert.match(res.error, /refusing to clear/i, 'error explains refusal');
    const after = await watchlist.get();
    assert.equal(after.count, before.count, 'list unchanged after refused clear');
  });

  // Destructive: opt-in only. Snapshots and restores the list contents.
  it('clear() empties the active list when name matches', async (t) => {
    if (process.env.WATCHLIST_DESTRUCTIVE_TESTS !== '1') {
      t.skip('set WATCHLIST_DESTRUCTIVE_TESTS=1 to run');
      return;
    }
    const before = await watchlist.get();
    const snapshot = before.symbols.map(s => s.symbol);
    try {
      const res = await watchlist.clear({ expect_list: before.active_list });
      assert.equal(res.success, true, 'clear succeeds with correct name');
      await sleep(300);
      const after = await watchlist.get();
      assert.equal(after.count, 0, 'list is empty after clear');
    } finally {
      for (const sym of snapshot) {
        await watchlist.add({ symbol: sym });
        await sleep(400);
      }
    }
  });

  it('sort() rejects a non-permutation (extra symbol, non-destructive)', async () => {
    const before = await watchlist.get();
    const input = before.symbols.map(s => s.symbol).concat('ZZZZ_FAKE');
    const res = await watchlist.sort({ symbols: input });
    assert.equal(res.success, false, 'sort refuses non-permutation');
    assert.ok(res.extra && res.extra.length > 0, 'reports extra symbols');
    const after = await watchlist.get();
    assert.equal(after.count, before.count, 'list unchanged after refused sort');
  });

  it('sort() reorders an exact permutation and restores order', async () => {
    const before = await watchlist.get();
    const original = before.symbols.map(s => s.symbol);
    if (original.length < 2) {
      return; // need at least two symbols to observe a reorder
    }
    const reversed = [...original].reverse();
    try {
      const res = await watchlist.sort({ symbols: reversed });
      assert.equal(res.success, true, 'sort succeeds for a permutation');
      await sleep(300);
      const after = await watchlist.get();
      const got = after.symbols.map(s => watchlist.normalizeSymbol(s.symbol));
      const want = reversed.map(s => watchlist.normalizeSymbol(s));
      assert.deepEqual(got, want, 'order matches the requested permutation');
    } finally {
      await watchlist.sort({ symbols: original });
      await sleep(300);
    }
  });
});
