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
});
