import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickScreenMatch, deriveComplete, ensureScreenerOpen, closeScreenerPanel, getActiveScreenName } from '../src/core/screener.js';

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
