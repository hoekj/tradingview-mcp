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
});
