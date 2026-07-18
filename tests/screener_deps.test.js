import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickScreenMatch, deriveComplete, ensureScreenerOpen, closeScreenerPanel, getActiveScreenName, openScreenDialog, readDialogRows, searchDialog, get, scrapeRows } from '../src/core/screener.js';

const ROWS = [
  { name: 'Pre-market most active', section: 'MY SCREENS' },
  { name: 'Cam Prefilter', section: 'MY SCREENS' },
  { name: 'Most active', section: 'MY SCREENS' },
  { name: 'All stocks', section: 'POPULAR SCREENS' },
  { name: 'Most active', section: 'POPULAR SCREENS' },
];

describe('pickScreenMatch()', () => {
  it('matches a unique name exactly', () => {
    const res = pickScreenMatch(ROWS, 'Cam Prefilter');
    assert.equal(res.status, 'ok');
    assert.equal(res.match.name, 'Cam Prefilter');
    assert.equal(res.match.section, 'MY SCREENS');
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    const res = pickScreenMatch(ROWS, '  cam prefilter  ');
    assert.equal(res.status, 'ok');
    assert.equal(res.match.name, 'Cam Prefilter');
  });

  it('reports ambiguity when the name appears in both sections', () => {
    const res = pickScreenMatch(ROWS, 'Most active');
    assert.equal(res.status, 'ambiguous');
    assert.equal(res.matches.length, 2);
    assert.deepEqual(res.matches.map(m => m.section), ['MY SCREENS', 'POPULAR SCREENS']);
  });

  it('reports not_found with the full available list', () => {
    const res = pickScreenMatch(ROWS, '__no_such_screen__');
    assert.equal(res.status, 'not_found');
    assert.equal(res.available.length, ROWS.length);
  });

  it('never matches on a substring', () => {
    // "Most" is a prefix of two entries but is not an exact name.
    const res = pickScreenMatch(ROWS, 'Most');
    assert.equal(res.status, 'not_found');
  });
});

describe('deriveComplete()', () => {
  it('is complete when the list does not overflow its scroller', () => {
    assert.equal(deriveComplete({ scrollHeight: 378, clientHeight: 378 }), true);
  });

  it('is incomplete when the list overflows', () => {
    assert.equal(deriveComplete({ scrollHeight: 900, clientHeight: 378 }), false);
  });

  it('tolerates sub-pixel rounding up to 4px', () => {
    assert.equal(deriveComplete({ scrollHeight: 380, clientHeight: 378 }), true);
  });

  it('is not complete when the measurement is unavailable', () => {
    // Never claim completeness we could not observe.
    assert.equal(deriveComplete({ scrollHeight: null, clientHeight: null }), false);
  });
});

// Build injected deps modelling the live screener panel. `state.open` is what
// the page reports; click() flips it the way the real button does.
function makePanelDeps({ open = false, closable = true, staysOpen = false } = {}) {
  const state = { open, clicks: [], closeClicked: false };
  const deps = {
    evaluate: async (expr) => {
      const src = String(expr);
      if (src.includes('screener-topbar-screen-title') && src.includes('!!')) {
        return state.open;
      }
      if (src.includes('screener-topbar-screen-title')) {
        return state.open ? 'Pre-market most active' : null;
      }
      if (src.includes('screenerContainer') && src.startsWith('!')) {
        return !state.open;
      }
      if (src.includes('close_button_not_found') || src.includes('aria-label="Close"')) {
        if (!state.open) { return { ok: true, note: 'already closed' }; }
        if (!closable) { return { ok: false, reason: 'close_button_not_found' }; }
        state.closeClicked = true;
        if (!staysOpen) {
          state.open = false;
        }
        return { ok: true, clicked: true };
      }
      return null;
    },
    click: async ({ by, value }) => {
      state.clicks.push(`${by}:${value}`);
      if (value === 'screener-dialog-button') { state.open = true; }
      return { success: true };
    },
    keyboard: async () => ({ success: true }),
    sleep: async () => {},
  };
  return { deps, state };
}

describe('ensureScreenerOpen()', () => {
  it('opens the panel and reports that it did so', async () => {
    const { deps, state } = makePanelDeps({ open: false });
    const res = await ensureScreenerOpen(deps);
    assert.equal(res.opened, true, 'reports it opened the panel');
    assert.deepEqual(state.clicks, ['data-name:screener-dialog-button']);
  });

  it('does not click when the panel is already open', async () => {
    const { deps, state } = makePanelDeps({ open: true });
    const res = await ensureScreenerOpen(deps);
    assert.equal(res.opened, false, 'reports it did not open the panel');
    assert.deepEqual(state.clicks, [], 'no click issued');
  });

  it('throws a DOM-change error when the panel never appears', async () => {
    const { deps } = makePanelDeps({ open: false });
    deps.click = async () => ({ success: true }); // click lands but nothing mounts
    await assert.rejects(() => ensureScreenerOpen(deps), /did not open/i);
  });
});

describe('closeScreenerPanel()', () => {
  it('closes an open panel', async () => {
    const { deps, state } = makePanelDeps({ open: true });
    const res = await closeScreenerPanel(deps);
    assert.equal(res, true);
    assert.equal(state.open, false, 'panel is closed');
    assert.equal(state.closeClicked, true, 'the close button was used');
  });

  it('is a no-op when the panel is already closed', async () => {
    const { deps, state } = makePanelDeps({ open: false });
    const res = await closeScreenerPanel(deps);
    assert.equal(res, true);
    assert.equal(state.closeClicked, false, 'nothing was clicked');
  });

  it('throws when the close button cannot be located', async () => {
    const { deps } = makePanelDeps({ open: true, closable: false });
    await assert.rejects(() => closeScreenerPanel(deps), /could not close/i);
  });

  it('throws when the panel is still present after the close click', async () => {
    const { deps } = makePanelDeps({ open: true, staysOpen: true });
    await assert.rejects(() => closeScreenerPanel(deps), /still open/i);
  });
});

describe('getActiveScreenName()', () => {
  it('reads the active screen title', async () => {
    const { deps } = makePanelDeps({ open: true });
    assert.equal(await getActiveScreenName(deps), 'Pre-market most active');
  });

  it('returns null when the screener is closed', async () => {
    const { deps } = makePanelDeps({ open: false });
    assert.equal(await getActiveScreenName(deps), null);
  });
});

const DIALOG_ROWS = [
  { name: 'Pre-market most active', section: 'MY SCREENS' },
  { name: 'Most active', section: 'MY SCREENS' },
  { name: 'All stocks', section: 'POPULAR SCREENS' },
];

function makeDialogDeps({ menuOpens = true, dialogOpens = true, rows = DIALOG_ROWS, hasInput = true } = {}) {
  const state = { dialogOpen: false, keys: [], typed: null, clicks: [] };
  const deps = {
    evaluate: async (expr) => {
      const src = String(expr);
      if (src.includes("'Open screen…'")) {
        return menuOpens ? { ok: true } : { ok: false, reason: 'menu not open' };
      }
      if (src.includes('screener-custom-screens-dialog') && src.includes('!!')) {
        return state.dialogOpen;
      }
      if (src.includes("placeholder === 'Search'") || src.includes('placeholder=="Search"')) {
        return hasInput ? { ok: true } : { ok: false };
      }
      if (src.includes('MY SCREENS')) {
        if (!state.dialogOpen) { return { ok: false, reason: 'dialog_gone' }; }
        return { ok: true, rows };
      }
      return null;
    },
    click: async ({ by, value }) => { state.clicks.push(`${by}:${value}`); return { success: true }; },
    keyboard: async ({ key }) => {
      state.keys.push(key);
      if (key === 'Enter' && state.keys.length === 1 && dialogOpens) { state.dialogOpen = true; }
      return { success: true };
    },
    typeText: async ({ text }) => { state.typed = text; return { success: true }; },
    sleep: async () => {},
  };
  return { deps, state };
}

describe('openScreenDialog()', () => {
  it('clicks the title, focuses the menu item and presses Enter', async () => {
    const { deps, state } = makeDialogDeps({});
    const res = await openScreenDialog(deps);
    assert.equal(res, true);
    assert.deepEqual(state.clicks, ['data-name:screener-topbar-screen-title']);
    assert.deepEqual(state.keys, ['Enter'], 'activated with a real Enter key');
  });

  it('throws when the title menu does not open', async () => {
    const { deps } = makeDialogDeps({ menuOpens: false });
    await assert.rejects(() => openScreenDialog(deps), /did not open/i);
  });

  it('throws when Enter does not produce the dialog', async () => {
    const { deps } = makeDialogDeps({ dialogOpens: false });
    await assert.rejects(() => openScreenDialog(deps), /did not open/i);
  });
});

describe('readDialogRows()', () => {
  it('returns rows tagged with their section', async () => {
    const { deps, state } = makeDialogDeps({});
    state.dialogOpen = true;
    const rows = await readDialogRows(deps);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { name: 'Pre-market most active', section: 'MY SCREENS' });
    assert.equal(rows[2].section, 'POPULAR SCREENS');
  });

  it('throws when the dialog has closed underneath it', async () => {
    const { deps } = makeDialogDeps({});
    await assert.rejects(() => readDialogRows(deps), /dialog/i);
  });
});

describe('searchDialog()', () => {
  it('focuses the search input and types the literal name', async () => {
    const { deps, state } = makeDialogDeps({});
    const res = await searchDialog('Cam Prefilter', deps);
    assert.equal(res, true);
    assert.equal(state.typed, 'Cam Prefilter');
  });

  it('throws when the search input is missing', async () => {
    const { deps } = makeDialogDeps({ hasInput: false });
    await assert.rejects(() => searchDialog('X', deps), /search/i);
  });
});

const KEYS = ['NYSE:NOK', 'NASDAQ:SOFI', 'AMEX:PSLV'];

// A full fake of the screener surface: panel, title menu, dialog, results table.
function makeFullDeps({
  startOpen = false,
  active = 'Cam Prefilter',
  rows = DIALOG_ROWS,
  keys = KEYS,
  overflow = false,
  selectLands = true,
  scrapeFails = false,
  closeFails = false,
  // Optional array of successive scrapeRows() reads for the poll tests below.
  // Each entry is either 'throw' (simulates the results table not yet being
  // mounted) or { rows, scrollHeight, clientHeight }. Consumed in order and
  // cycled (via modulo) if the poll outlives the array — this lets a short
  // array express "never settles" for the exhaustion tests. Defaults to null
  // so every existing test keeps using the single-shot scrapeFails/keys
  // behavior below, completely unaffected.
  scrapeReads = null,
} = {}) {
  const state = {
    open: startOpen, active, dialogOpen: false,
    keys: [], typed: null, clicks: [], closed: false, escapes: 0, scrapeCalls: 0,
  };
  const deps = {
    evaluate: async (expr) => {
      const src = String(expr);
      if (src.includes('screener-topbar-screen-title') && src.includes('!!')) { return state.open; }
      if (src.includes('screener-topbar-screen-title') && src.includes('innerText')) {
        return state.open ? state.active : null;
      }
      if (src.includes("'Open screen…'")) { return { ok: true }; }
      if (src.includes('screener-custom-screens-dialog') && src.includes('!!')) { return state.dialogOpen; }
      if (src.includes("placeholder === 'Search'")) { return { ok: true }; }
      if (src.includes('MY SCREENS')) {
        if (!state.dialogOpen) { return { ok: false, reason: 'dialog_gone' }; }
        const q = (state.typed || '').trim().toLowerCase();
        return { ok: true, rows: q ? rows.filter(r => r.name.toLowerCase().includes(q)) : rows };
      }
      if (src.includes('selectable-rows-table-body')) {
        if (scrapeReads) {
          const entry = scrapeReads[state.scrapeCalls % scrapeReads.length];
          state.scrapeCalls++;
          if (entry === 'throw') { return { ok: false, reason: 'no_results_table' }; }
          return { ok: true, rows: entry.rows, scrollHeight: entry.scrollHeight, clientHeight: entry.clientHeight };
        }
        if (scrapeFails) { return { ok: false, reason: 'no_results_table' }; }
        return {
          ok: true, rows: keys,
          scrollHeight: overflow ? 900 : 378,
          clientHeight: 378,
        };
      }
      if (src.includes('screenerContainer') && src.trim().startsWith('!')) { return !state.open; }
      if (src.includes('aria-label="Close"')) {
        if (!state.open) { return { ok: true, note: 'already closed' }; }
        if (closeFails) { return { ok: false, reason: 'close_button_not_found' }; }
        state.open = false; state.closed = true;
        return { ok: true, clicked: true };
      }
      return null;
    },
    click: async ({ by, value }) => {
      state.clicks.push(`${by}:${value}`);
      if (value === 'screener-dialog-button') { state.open = true; }
      return { success: true };
    },
    keyboard: async ({ key }) => {
      state.keys.push(key);
      if (key === 'Enter' && !state.dialogOpen) { state.dialogOpen = true; return { success: true }; }
      if (key === 'Enter' && state.dialogOpen && state.keys.includes('ArrowDown')) {
        state.dialogOpen = false;
        if (selectLands) { state.active = (state.typed || '').trim(); }
      }
      if (key === 'Escape') { state.escapes++; state.dialogOpen = false; }
      return { success: true };
    },
    typeText: async ({ text }) => { state.typed = text; return { success: true }; },
    sleep: async () => {},
  };
  return { deps, state };
}

describe('scrapeRows()', () => {
  it('returns rowkeys verbatim with the scroller measurements', async () => {
    const { deps } = makeFullDeps({ startOpen: true });
    const res = await scrapeRows(deps);
    assert.deepEqual(res.rows, KEYS, 'exchange-qualified symbols preserved');
    assert.equal(res.clientHeight, 378);
  });
});

describe('get()', () => {
  it('selects the requested screen and returns its rows', async () => {
    const { deps, state } = makeFullDeps({ active: 'Cam Prefilter' });
    const res = await get({ screenName: 'Pre-market most active', _deps: deps });
    assert.equal(res.success, true, 'succeeds');
    assert.equal(res.screen, 'Pre-market most active', 'reports the active screen');
    assert.deepEqual(res.rows, KEYS);
    assert.equal(res.count, 3);
    assert.equal(res.complete, true);
    assert.equal(res.total, null, 'total is never inferred');
    assert.deepEqual(state.keys.filter(k => k === 'ArrowDown'), ['ArrowDown'], 'highlight moved into the list before Enter');
  });

  it('short-circuits when the screen is already active', async () => {
    const { deps, state } = makeFullDeps({ active: 'Pre-market most active' });
    const res = await get({ screenName: 'pre-market MOST active', _deps: deps });
    assert.equal(res.success, true);
    assert.equal(res.note, 'already active');
    assert.deepEqual(state.clicks.filter(c => c.includes('screen-title')), [], 'the title menu was never opened');
  });

  it('scrapes the active screen when screenName is omitted', async () => {
    const { deps, state } = makeFullDeps({ active: 'Cam Prefilter' });
    const res = await get({ _deps: deps });
    assert.equal(res.success, true);
    assert.equal(res.screen, 'Cam Prefilter');
    assert.equal(state.typed, null, 'no search was performed');
  });

  it('returns not_found with the available list', async () => {
    const { deps } = makeFullDeps({ active: 'Cam Prefilter' });
    const res = await get({ screenName: '__no_such_screen__', _deps: deps });
    assert.equal(res.success, false);
    assert.match(res.error, /not found/i);
    assert.ok(Array.isArray(res.available), 'available is a list');
    assert.ok(res.available.length > 0, 'available is not empty');
    assert.ok(
      res.available.some((r) => r.name === 'Pre-market most active'),
      'available contains the known screens, read before the dialog was narrowed by typing'
    );
  });

  it('refuses an ambiguous name rather than guessing', async () => {
    const ambiguous = [
      { name: 'Most active', section: 'MY SCREENS' },
      { name: 'Most active', section: 'POPULAR SCREENS' },
    ];
    const { deps } = makeFullDeps({ active: 'Cam Prefilter', rows: ambiguous });
    const res = await get({ screenName: 'Most active', _deps: deps });
    assert.equal(res.success, false);
    assert.match(res.error, /ambiguous/i);
    assert.equal(res.matches.length, 2);
  });

  it('rejects a blank screenName', async () => {
    const { deps } = makeFullDeps({});
    const res = await get({ screenName: '   ', _deps: deps });
    assert.equal(res.success, false);
    assert.match(res.error, /required/i);
  });

  it('fails loudly when the title does not change after selecting', async () => {
    const { deps } = makeFullDeps({ active: 'Cam Prefilter', selectLands: false });
    const res = await get({ screenName: 'Pre-market most active', _deps: deps });
    assert.equal(res.success, false);
    assert.match(res.error, /but the active screen is/i);
  });

  it('reports incomplete when the results overflow', async () => {
    const { deps } = makeFullDeps({ active: 'Pre-market most active', overflow: true });
    const res = await get({ screenName: 'Pre-market most active', _deps: deps });
    assert.equal(res.complete, false);
    assert.equal(res.count, 3, 'still reports what it did get');
  });

  it('closes the panel it opened', async () => {
    const { deps, state } = makeFullDeps({ startOpen: false, active: 'Pre-market most active' });
    await get({ screenName: 'Pre-market most active', _deps: deps });
    assert.equal(state.closed, true, 'panel closed again');
  });

  it('leaves a panel it did not open alone', async () => {
    const { deps, state } = makeFullDeps({ startOpen: true, active: 'Pre-market most active' });
    await get({ screenName: 'Pre-market most active', _deps: deps });
    assert.equal(state.closed, false, 'user panel untouched');
    assert.equal(state.open, true);
  });

  it('restores panel state even when the call fails', async () => {
    const { deps, state } = makeFullDeps({ startOpen: false, active: 'Cam Prefilter' });
    const res = await get({ screenName: '__no_such_screen__', _deps: deps });
    assert.equal(res.success, false);
    assert.equal(state.closed, true, 'panel closed despite the failure');
    assert.ok(state.escapes > 0, 'the dialog was dismissed');
  });

  it('converts a thrown helper error into success:false and still restores the panel', async () => {
    // scrapeRows throws when the results table cannot be read; the try/catch in
    // get() must convert that thrown error into a normal {success:false} result.
    const { deps, state } = makeFullDeps({ startOpen: false, active: 'Pre-market most active', scrapeFails: true });
    const res = await get({ screenName: 'Pre-market most active', _deps: deps });
    assert.equal(res.success, false, 'the throw was caught, not propagated');
    assert.match(res.error, /could not read the screener results table/i);
    assert.equal(state.closed, true, 'the finally block still restored the panel');
  });

  it('never lets a cleanup failure mask the real result', async () => {
    // closeScreenerPanel throws when the close button cannot be found; the
    // finally block's try/catch(_) must swallow that and preserve the real
    // outcome that was already decided.
    const { deps, state } = makeFullDeps({ startOpen: false, active: 'Cam Prefilter', closeFails: true });
    const res = await get({ screenName: 'Pre-market most active', _deps: deps });
    assert.equal(res.success, true, 'the real success is returned, not a cleanup error');
    assert.equal(res.screen, 'Pre-market most active');
    assert.equal(state.closed, false, 'the close attempt failed as configured');
  });

  it('never lets a cleanup failure mask a real error', async () => {
    const { deps, state } = makeFullDeps({ startOpen: false, active: 'Cam Prefilter', closeFails: true });
    const res = await get({ screenName: '__no_such_screen__', _deps: deps });
    assert.equal(res.success, false, 'the real not_found error is returned, not a cleanup error');
    assert.match(res.error, /not found/i);
    assert.equal(state.closed, false, 'the close attempt failed as configured');
  });
});

describe('get() — results poll (waitForResultsReady)', () => {
  it('retries a zero-row first read and succeeds with the settled non-empty rows', async () => {
    const { deps } = makeFullDeps({
      startOpen: true,
      active: 'Cam Prefilter',
      scrapeReads: [
        { rows: [], scrollHeight: null, clientHeight: null },
        { rows: ['NYSE:AAA', 'NASDAQ:BBB'], scrollHeight: 400, clientHeight: 400 },
        { rows: ['NYSE:AAA', 'NASDAQ:BBB'], scrollHeight: 400, clientHeight: 400 },
      ],
    });
    const res = await get({ _deps: deps });
    assert.equal(res.success, true);
    assert.deepEqual(res.rows, ['NYSE:AAA', 'NASDAQ:BBB'], 'settled rows returned once the table populates');
    assert.equal(res.count, 2);
    assert.equal(res.stale, undefined, 'a settled read is not stale');
  });

  it('returns the SETTLED reading, not the first non-empty one, once counts stop changing', async () => {
    const { deps } = makeFullDeps({
      startOpen: true,
      active: 'Cam Prefilter',
      scrapeReads: [
        { rows: ['NYSE:AAA'], scrollHeight: 500, clientHeight: 300 },
        { rows: ['NYSE:AAA', 'NASDAQ:BBB'], scrollHeight: 700, clientHeight: 300 },
        { rows: ['NYSE:AAA', 'NASDAQ:BBB', 'AMEX:CCC'], scrollHeight: 900, clientHeight: 300 },
        { rows: ['NYSE:AAA', 'NASDAQ:BBB', 'AMEX:CCC'], scrollHeight: 900, clientHeight: 300 },
      ],
    });
    const res = await get({ _deps: deps });
    assert.equal(res.success, true);
    assert.deepEqual(
      res.rows,
      ['NYSE:AAA', 'NASDAQ:BBB', 'AMEX:CCC'],
      'the settled 3-row reading is returned, not the first non-empty 1-row reading'
    );
    assert.equal(res.count, 3);
    assert.equal(res.stale, undefined);
  });

  it('retries a scrapeRows throw on early ticks and succeeds once the table mounts', async () => {
    const { deps } = makeFullDeps({
      startOpen: true,
      active: 'Cam Prefilter',
      scrapeReads: [
        'throw',
        'throw',
        { rows: ['NYSE:ZZZ'], scrollHeight: 300, clientHeight: 300 },
        { rows: ['NYSE:ZZZ'], scrollHeight: 300, clientHeight: 300 },
      ],
    });
    const res = await get({ _deps: deps });
    assert.equal(res.success, true, 'an early mount-race throw does not fail the call');
    assert.deepEqual(res.rows, ['NYSE:ZZZ']);
    assert.equal(res.stale, undefined);
  });

  it('re-raises as a normal failure when every tick throws until the budget expires', async () => {
    const { deps } = makeFullDeps({
      startOpen: true,
      active: 'Cam Prefilter',
      scrapeReads: ['throw'],
    });
    const res = await get({ _deps: deps });
    assert.equal(res.success, false, 'a genuinely absent table still surfaces as a failure');
    assert.match(res.error, /could not read the screener results table/i);
  });

  it('marks the result stale when the budget expires without ever settling', async () => {
    const { deps } = makeFullDeps({
      startOpen: true,
      active: 'Cam Prefilter',
      // Alternates forever with rows always empty — adjacent reads never agree,
      // so the poll never settles and must exhaust its budget.
      scrapeReads: [
        { rows: [], scrollHeight: 100, clientHeight: 50 },
        { rows: [], scrollHeight: 200, clientHeight: 50 },
      ],
    });
    const res = await get({ _deps: deps });
    assert.equal(res.success, true, 'exhaustion is not an error');
    assert.equal(res.count, 0, 'count stays truthful to the last read');
    assert.equal(res.total, null);
    assert.equal(res.stale, true, 'the caller can tell this result was never proven settled');
  });

  it('exhausts the budget on a persistently empty screen and reports stale:true', async () => {
    // Two (or more) consecutive EMPTY reads agree trivially (0 === 0, and an
    // empty table's scrollHeight/clientHeight equal each other) — that trivial
    // agreement is exactly the transient "table mounted, rows not painted yet"
    // state the settle requirement exists to wait out. A settled read may only
    // short-circuit the poll when it is NON-EMPTY, so a screen that never
    // produces rows correctly costs the full poll budget and comes back
    // flagged stale, since "matches nothing" and "never finished rendering"
    // are indistinguishable from in here.
    const { deps } = makeFullDeps({
      startOpen: true,
      active: 'Cam Prefilter',
      scrapeReads: [{ rows: [], scrollHeight: 376, clientHeight: 376 }],
    });
    const res = await get({ _deps: deps });
    assert.equal(res.success, true, 'exhaustion is not an error');
    assert.equal(res.count, 0);
    assert.equal(res.stale, true, 'an empty result can never be confirmed settled, so it is always flagged stale');
  });

  it('does NOT settle on two agreeing empty reads even when real rows arrive later (regression)', async () => {
    // Reproduces the Critical: right after a panel-open or screen-switch, the
    // table can be mounted-but-empty for a couple of ticks before real rows
    // paint. The first two observations here are EMPTY and agree with each
    // other on rows.length/scrollHeight/clientHeight — under the old "any two
    // agreeing reads settle" rule that agreement alone would end the poll
    // immediately with rows: [] and complete: true, silently discarding the
    // real rows that show up two ticks later. get() must keep polling past
    // the empty agreement and return the real, later-settled rows instead.
    const { deps } = makeFullDeps({
      startOpen: true,
      active: 'Cam Prefilter',
      scrapeReads: [
        { rows: [], scrollHeight: 200, clientHeight: 200 },
        { rows: [], scrollHeight: 200, clientHeight: 200 },
        { rows: ['NYSE:AAA'], scrollHeight: 300, clientHeight: 300 },
        { rows: ['NYSE:AAA'], scrollHeight: 300, clientHeight: 300 },
      ],
    });
    const res = await get({ _deps: deps });
    assert.equal(res.success, true);
    assert.deepEqual(res.rows, ['NYSE:AAA'], 'the real rows are returned, not an empty settled result');
    assert.equal(res.count, 1);
    assert.equal(res.stale, undefined, 'the real rows settled cleanly, so this is not stale');
  });
});
