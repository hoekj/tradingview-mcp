/**
 * Core watchlist logic.
 * Uses TradingView's internal widget API with DOM fallback.
 */
import { evaluate, evaluateAsync, getClient, safeString } from '../connection.js';

// Shared in-page helper injected into evaluate() scripts. Defines removeRow(el):
// given an element carrying [data-symbol-full], locate its row container and click
// the per-row remove button. Returns true if a button was found and clicked, false
// if no remove button exists (a stuck row). Inlined here (not the Node-side code)
// because it executes in the page context via CDP and cannot reach Node functions.
const REMOVE_ROW_SNIPPET = `
  function removeRow(el) {
    var row = el.closest('[class*="symbol-"]') || el.closest('[class*="row"]') || el.parentElement;
    var btn = row ? row.querySelector('[class*="removeButton"]') : null;
    if (!btn) { return false; }
    btn.click();
    return true;
  }
`;

/**
 * Normalize a symbol for matching. Compares case-insensitively and strips the
 * exchange prefix so a caller's "AAPL" matches a row's "NASDAQ:AAPL".
 */
export function normalizeSymbol(s) {
  const upper = String(s).toUpperCase().trim();
  const colon = upper.indexOf(':');
  return colon >= 0 ? upper.slice(colon + 1) : upper;
}

/**
 * Activate the watchlist tab in the right panel if it is not already showing.
 * Other widgets (alerts, object tree) can occupy the same panel, so the
 * watchlist must be mounted before reading or mutating rows.
 */
export async function ensureWatchlistOpen() {
  const state = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[aria-label*="Watchlist"]');
      if (!btn) return { error: 'Watchlist button not found' };
      // Check whether the watchlist panel is already rendered and visible.
      // Check for the add-symbol button or a watchlist-specific container being
      // present and visible — this works even when the list is empty (no rows).
      var addBtn = document.querySelector('[data-name="add-symbol-button"]')
        || document.querySelector('[aria-label="Add symbol"]');
      var panel = document.querySelector('[data-name="watchlist-widget"]')
        || document.querySelector('[class*="watchlistWrapper"]')
        || document.querySelector('[class*="watchlist-widget"]');
      var panelVisible = (addBtn && addBtn.offsetParent !== null)
        || (panel && panel.offsetParent !== null);
      if (!panelVisible) { btn.click(); return { opened: true }; }
      return { opened: false };
    })()
  `);
  if (state?.error) {
    throw new Error(state.error);
  }
  if (state?.opened) {
    await new Promise(r => setTimeout(r, 500));
  }
}

/**
 * Read the name of the currently active watchlist (e.g. "Today").
 */
export async function getActiveListName() {
  const name = await evaluate(`
    (function() {
      var el = document.querySelector('[data-name="watchlists-button"]');
      return el ? el.textContent.trim() : null;
    })()
  `);
  return name || null;
}

export async function get() {
  // Try internal API first — reads from the active watchlist widget
  const symbols = await evaluate(`
    (function() {
      // Method 1: Try the watchlist widget's internal data
      try {
        var rightArea = document.querySelector('[class*="layout__area--right"]');
        if (!rightArea || rightArea.offsetWidth < 50) return { symbols: [], source: 'panel_closed' };
      } catch(e) {}

      // Method 2: Read data-symbol-full attributes from watchlist rows
      var results = [];
      var seen = {};
      var container = document.querySelector('[class*="layout__area--right"]');
      if (!container) return { symbols: [], source: 'no_container' };

      // Find all elements with symbol data attributes
      var symbolEls = container.querySelectorAll('[data-symbol-full]');
      for (var i = 0; i < symbolEls.length; i++) {
        var sym = symbolEls[i].getAttribute('data-symbol-full');
        if (!sym || seen[sym]) continue;
        seen[sym] = true;

        // Find the row and extract price data
        var row = symbolEls[i].closest('[class*="row"]') || symbolEls[i].parentElement;
        var cells = row ? row.querySelectorAll('[class*="cell"], [class*="column"]') : [];
        var nums = [];
        for (var j = 0; j < cells.length; j++) {
          var t = cells[j].textContent.trim();
          if (t && /^[\\-+]?[\\d,]+\\.?\\d*%?$/.test(t.replace(/[\\s,]/g, ''))) nums.push(t);
        }
        results.push({ symbol: sym, last: nums[0] || null, change: nums[1] || null, change_percent: nums[2] || null });
      }

      if (results.length > 0) return { symbols: results, source: 'data_attributes' };

      // Method 3: Scan for ticker-like text in the right panel
      var items = container.querySelectorAll('[class*="symbolName"], [class*="tickerName"], [class*="symbol-"]');
      for (var k = 0; k < items.length; k++) {
        var text = items[k].textContent.trim();
        if (text && /^[A-Z][A-Z0-9.:!]{0,20}$/.test(text) && !seen[text]) {
          seen[text] = true;
          results.push({ symbol: text, last: null, change: null, change_percent: null });
        }
      }

      return { symbols: results, source: results.length > 0 ? 'text_scan' : 'empty' };
    })()
  `);

  const active_list = await getActiveListName();

  return {
    success: true,
    active_list,
    count: symbols?.symbols?.length || 0,
    source: symbols?.source || 'unknown',
    symbols: symbols?.symbols || [],
  };
}

export async function remove({ symbol }) {
  await ensureWatchlistOpen();

  const result = await evaluate(`
    (function(symbol) {
      ${REMOVE_ROW_SNIPPET}
      function norm(s) {
        var u = String(s).toUpperCase().trim();
        var c = u.indexOf(':');
        return c >= 0 ? u.slice(c + 1) : u;
      }
      var target = norm(symbol);
      var els = document.querySelectorAll('[data-symbol-full]');
      for (var i = 0; i < els.length; i++) {
        var full = els[i].getAttribute('data-symbol-full');
        if (norm(full) === target || String(full).toUpperCase() === String(symbol).toUpperCase()) {
          if (!removeRow(els[i])) { return { found: true, removed: false, reason: 'remove_button_not_found' }; }
          return { found: true, removed: true, matched: full };
        }
      }
      return { found: false };
    })(${safeString(symbol)})
  `);

  if (!result?.found) {
    return { success: true, removed: false, symbol, note: symbol + ' not in active list' };
  }
  if (!result.removed) {
    throw new Error('Found ' + symbol + ' but its remove button was not found');
  }
  return { success: true, removed: true, symbol, matched: result.matched };
}

export async function clear({ expect_list } = {}) {
  await ensureWatchlistOpen();

  const activeList = await getActiveListName();
  if (expect_list != null && String(expect_list).trim().toLowerCase() !== String(activeList || '').trim().toLowerCase()) {
    return {
      success: false,
      error: "Active list is '" + activeList + "', expected '" + expect_list + "' — refusing to clear",
    };
  }

  const MAX_ITERATIONS = 200;
  let removedCount = 0;
  let stuck = false;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await evaluate(`
      (function() {
        ${REMOVE_ROW_SNIPPET}
        var el = document.querySelector('[data-symbol-full]');
        if (!el) { return { removed: false }; }
        if (!removeRow(el)) { return { removed: false, reason: 'remove_button_not_found' }; }
        return { removed: true };
      })()
    `);
    if (!res?.removed) {
      if (res?.reason === 'remove_button_not_found') {
        stuck = true;
      }
      break;
    }
    removedCount++;
    await new Promise(r => setTimeout(r, 150));
  }

  if (stuck) {
    return {
      success: false,
      cleared: false,
      removed_count: removedCount,
      list: activeList,
      error: 'Removed ' + removedCount + ' symbol(s) but a remaining row had no remove button — list not fully cleared',
    };
  }

  return { success: true, cleared: true, removed_count: removedCount, list: activeList };
}

/**
 * Reorder the active watchlist to match the supplied symbol order.
 * The input must be an exact permutation of the current list — no extras,
 * no omissions, no duplicates. On any mismatch the call is rejected and the
 * list is left untouched.
 *
 * Reorder is implemented as clear + sequential re-add because TradingView
 * does not expose a drag-to-reorder API via CDP.
 */
export async function sort({ symbols }) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return { success: false, error: 'symbols must be a non-empty array' };
  }

  await ensureWatchlistOpen();

  const current = await get();
  const currentNorm = current.symbols.map(s => normalizeSymbol(s.symbol));
  const inputNorm = symbols.map(s => normalizeSymbol(s));

  // Reject duplicates in the input — a permutation has no repeats.
  const seen = new Set();
  const dupes = [];
  for (const s of inputNorm) {
    if (seen.has(s)) {
      dupes.push(s);
    }
    seen.add(s);
  }

  const currentSet = new Set(currentNorm);
  const inputSet = new Set(inputNorm);
  const missing = currentNorm.filter(s => !inputSet.has(s));
  const extra = inputNorm.filter(s => !currentSet.has(s));

  if (dupes.length > 0 || missing.length > 0 || extra.length > 0) {
    return {
      success: false,
      error: 'symbols must be an exact permutation of the active list',
      missing,
      extra,
      duplicates: dupes,
    };
  }

  // Validated: same set, no dupes. Clear then re-add in the requested order.
  // Use a longer settle delay after clear so the panel re-renders the add button.
  await clear({});
  await new Promise(r => setTimeout(r, 1000));
  for (const sym of symbols) {
    await add({ symbol: sym });
    await new Promise(r => setTimeout(r, 400));
  }

  const final = await get();
  return { success: true, sorted: true, order: final.symbols.map(s => s.symbol) };
}

export async function add({ symbol }) {
  // Use keyboard shortcut to open symbol search in watchlist, type symbol, press Enter
  const c = await getClient();

  await ensureWatchlistOpen();

  // Click the "Add symbol" button (various selectors)
  const addClicked = await evaluate(`
    (function() {
      var selectors = [
        '[data-name="add-symbol-button"]',
        '[aria-label="Add symbol"]',
        '[aria-label*="Add symbol"]',
        'button[class*="addSymbol"]',
      ];
      for (var s = 0; s < selectors.length; s++) {
        var btn = document.querySelector(selectors[s]);
        if (btn && btn.offsetParent !== null) { btn.click(); return { found: true, selector: selectors[s] }; }
      }
      // Fallback: find + button in right panel
      var container = document.querySelector('[class*="layout__area--right"]');
      if (container) {
        var buttons = container.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
          var ariaLabel = buttons[i].getAttribute('aria-label') || '';
          if (/add.*symbol/i.test(ariaLabel) || buttons[i].textContent.trim() === '+') {
            buttons[i].click();
            return { found: true, method: 'fallback' };
          }
        }
      }
      return { found: false };
    })()
  `);

  if (!addClicked?.found) throw new Error('Add symbol button not found in watchlist panel');
  await new Promise(r => setTimeout(r, 300));

  // Type the symbol into the search input
  await c.Input.insertText({ text: symbol });
  await new Promise(r => setTimeout(r, 500));

  // Press Enter to select the first result
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  await new Promise(r => setTimeout(r, 300));

  // Press Escape to close search
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });

  return { success: true, symbol, action: 'added' };
}
