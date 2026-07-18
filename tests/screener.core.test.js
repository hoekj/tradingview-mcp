import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as screener from '../src/core/screener.js';
import { disconnect } from '../src/connection.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SCREEN = 'Pre-market most active';

describe('screener core (live e2e)', () => {
  let startingScreen = null;
  let startedOpen = false;

  before(async () => {
    // Snapshot the user's screener state so the suite can restore it.
    const opened = await screener.ensureScreenerOpen();
    startedOpen = !opened.opened;
    startingScreen = await screener.getActiveScreenName();
    if (!startedOpen) {
      await screener.closeScreenerPanel();
    }
    await sleep(300);
  });

  after(async () => {
    // Restore the original screen and panel state, then close the shared CDP
    // websocket so `node --test` can exit instead of hanging.
    //
    // The final test in this suite deliberately leaves the panel open (it
    // opens the panel itself before calling get(), so get()'s own cleanup
    // correctly leaves a panel alone that it did not open). That means this
    // hook must explicitly force the panel CLOSED when the suite started
    // closed — relying on get({screenName: startingScreen}) alone is not
    // enough, since that call also leaves an already-open panel open. See
    // task-6-report.md for the reproduction.
    try {
      if (startingScreen) {
        const restored = await screener.get({ screenName: startingScreen });
        if (!restored.success) {
          // Never swallow this silently — a failed restore leaves the user's
          // real trading workspace on the wrong screen even though the suite
          // itself reports green.
          console.warn(
            `screener.core.test.js: failed to restore starting screen "${startingScreen}": ${restored.error}`
          );
        }
      }
      if (startedOpen) {
        await screener.ensureScreenerOpen();
      } else {
        await screener.closeScreenerPanel();
      }
    } catch (err) {
      console.warn(`screener.core.test.js: cleanup threw while restoring workspace state: ${err.message}`);
    }
    await disconnect();
  });

  it('returns rows for a named screen', async () => {
    const res = await screener.get({ screenName: SCREEN });
    assert.equal(res.success, true, 'get succeeds');
    assert.equal(res.screen, SCREEN, 'the requested screen is active');
    assert.ok(Array.isArray(res.rows), 'rows is an array');
    assert.ok(res.rows.length > 0, 'rows is non-empty');
    assert.equal(res.count, res.rows.length, 'count matches rows');
    assert.equal(typeof res.complete, 'boolean', 'complete is a boolean');
    assert.equal(res.total, null, 'total is null — TradingView exposes no count');
  });

  it('returns exchange-qualified symbols', async () => {
    const res = await screener.get({ screenName: SCREEN });
    assert.ok(res.rows.length > 0, 'precondition: there are rows to check — otherwise this test passes vacuously');
    for (const row of res.rows) {
      assert.match(row, /^[A-Z]+:[A-Z0-9.]+$/, `${row} is EXCH:TICKER`);
    }
  });

  it('short-circuits on a second consecutive call', async () => {
    await screener.get({ screenName: SCREEN });
    await sleep(300);
    const res = await screener.get({ screenName: SCREEN });
    assert.equal(res.success, true, 'second call succeeds');
    assert.equal(res.note, 'already active', 'took the short-circuit path');
    assert.ok(res.rows.length > 0, 'still returns rows');
  });

  it('scrapes the active screen when screenName is omitted', async () => {
    await screener.get({ screenName: SCREEN });
    await sleep(300);
    const res = await screener.get({});
    assert.equal(res.success, true);
    assert.equal(res.screen, SCREEN);
    assert.ok(res.rows.length > 0);
  });

  it('fails loudly on an unknown screen and lists what is available', async () => {
    const res = await screener.get({ screenName: '__no_such_screen__' });
    assert.equal(res.success, false, 'does not fall through to a wrong screen');
    assert.match(res.error, /not found/i);
    assert.ok(Array.isArray(res.available), 'available is a list');
    assert.ok(res.available.length > 0, 'available is non-empty');
    assert.ok(res.available.some(r => r.name === SCREEN), 'the real screen is listed');
  });

  it('restores panel state — closed before, closed after', async () => {
    // Force the "closed before" precondition directly: closeScreenerPanel is a
    // no-op when the panel is already closed, so this reliably reaches closed
    // state regardless of what the previous test left behind. (The original
    // ensureScreenerOpen()-then-conditional-close approach here inverted the
    // precondition — see task-6-report.md for the reproduction.)
    await screener.closeScreenerPanel();
    await sleep(300);

    const res = await screener.get({ screenName: SCREEN });
    assert.equal(res.success, true);
    await sleep(400);

    const stillOpen = await screener.getActiveScreenName();
    assert.equal(stillOpen, null, 'panel closed again after the call');
  });

  it('restores panel state — open before, open after', async () => {
    await screener.ensureScreenerOpen();
    await sleep(300);

    const res = await screener.get({ screenName: SCREEN });
    assert.equal(res.success, true);
    await sleep(400);

    const name = await screener.getActiveScreenName();
    assert.equal(name, SCREEN, 'panel left open, as it was found');
  });

  it('reports complete:false on a screen large enough to overflow the results scroller', async () => {
    // "All stocks" is a POPULAR SCREENS entry present in every workspace, so
    // this needs no user-specific fixture. It also exercises the large-screen
    // path where a settle-on-first-non-empty-read bug would truncate rows
    // while still reporting complete:true — the scroller anchor
    // (body.closest('[class*="wrapper"]')) is the most fragile part of this
    // module, and `assert.equal(typeof res.complete, 'boolean')` elsewhere in
    // this file is satisfied even by a hardcoded `true`, so this is the only
    // test that actually proves complete:false is reachable.
    //
    // Note: pickScreenMatch() errors on ambiguity rather than guessing, so a
    // workspace that also has a MY SCREENS entry literally named "All stocks"
    // would make screener.get() below fail with an "ambiguous" error — and
    // this test would fail for a reason that has nothing to do with the code
    // actually under test here (overflow/completeness detection).
    const res = await screener.get({ screenName: 'All stocks' });
    assert.equal(res.success, true);
    assert.equal(res.complete, false, 'All stocks has enough rows to overflow the results scroller');
    // TradingView caps rendered rows at exactly 100, so asserting `count >= 100`
    // really only asserts "the paging cap was reached" rather than testing
    // overflow detection itself. Asserting count > 0 together with
    // complete === false exercises overflow detection directly and survives a
    // future change to the cap.
    assert.ok(res.count > 0, `expected at least some rows, got ${res.count}`);

    // Restore to the suite's screen before the next test runs.
    const restored = await screener.get({ screenName: SCREEN });
    assert.equal(restored.success, true);
    await sleep(300);
  });

  it('leaves no dialog open after a failed call', async () => {
    await screener.get({ screenName: '__no_such_screen__' });
    await sleep(400);
    await screener.ensureScreenerOpen();
    const rows = await screener.get({ screenName: SCREEN });
    assert.equal(rows.success, true, 'the next call is unaffected by the failure');
  });
});
