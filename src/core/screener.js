/**
 * Core screener logic.
 *
 * TradingView exposes no screener API, so selection and scraping are DOM-driven
 * through the screener panel, consistent with core/watchlist.js. Anchors are
 * stable data-name attributes and literal visible text; hashed CSS classes are
 * matched by prefix only, as hints, because they regenerate on every release.
 */

import { evaluate as evaluateImpl } from '../connection.js';
import { click as clickImpl, keyboard as keyboardImpl, typeText as typeTextImpl } from './ui.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve injectable dependencies. Every DOM-touching function takes an
 * optional deps object so the flow can be unit-tested without a browser,
 * matching the pattern used by layoutSwitch in core/ui.js.
 */
function resolveDeps(_deps) {
  return {
    evaluate: _deps?.evaluate || evaluateImpl,
    click: _deps?.click || clickImpl,
    keyboard: _deps?.keyboard || keyboardImpl,
    typeText: _deps?.typeText || typeTextImpl,
    sleep: _deps?.sleep || defaultSleep,
  };
}

/**
 * Poll `fn` until it returns true or the budget expires. Returns false on
 * timeout so callers can raise a specific error instead of hanging.
 */
async function waitFor(fn, deps, { maxMs = 10000, interval = 250 } = {}) {
  const ticks = Math.ceil(maxMs / interval);
  for (let i = 0; i < ticks; i++) {
    let ok = false;
    try {
      ok = await fn();
    } catch (_) {
      ok = false;
    }
    if (ok) {
      return true;
    }
    if (i < ticks - 1) {
      await deps.sleep(interval);
    }
  }
  return false;
}

/**
 * Choose the single screen row matching `name`.
 *
 * The Open-screen dialog lists MY SCREENS and POPULAR SCREENS together, so a
 * name can legitimately appear twice. Matching is exact (case-insensitive,
 * trimmed) and ambiguity is an error rather than a first-match guess — picking
 * one silently is how a caller ends up scraping the wrong screen.
 */
export function pickScreenMatch(rows, name) {
  const target = String(name).trim().toLowerCase();
  const matches = rows.filter((r) => String(r.name).trim().toLowerCase() === target);
  if (matches.length === 1) {
    return { status: 'ok', match: matches[0] };
  }
  if (matches.length === 0) {
    return { status: 'not_found', available: rows };
  }
  return { status: 'ambiguous', matches };
}

/**
 * Decide whether the scraped rows are the whole result set.
 *
 * The screener renders only what fits and exposes no total, so completeness is
 * inferred from overflow: if the scroll container does not overflow, everything
 * loaded is already in the DOM. A missing measurement yields false — we never
 * claim a completeness we could not observe.
 */
export function deriveComplete({ scrollHeight, clientHeight }) {
  if (typeof scrollHeight !== 'number' || typeof clientHeight !== 'number') {
    return false;
  }
  return !(scrollHeight > clientHeight + 4);
}

/**
 * Read the name of the currently active screen, or null when the screener
 * panel is not mounted.
 */
export async function getActiveScreenName(_deps) {
  const d = resolveDeps(_deps);
  const name = await d.evaluate(`
    (function() {
      var el = document.querySelector('[data-name="screener-topbar-screen-title"]');
      return el ? el.innerText.trim() : null;
    })()
  `);
  return name || null;
}

/**
 * Mount the screener panel if it is not already showing.
 *
 * Clicking the toolbar button while the screener is open does NOT toggle it
 * closed, so this is safe to call unconditionally — but it still short-circuits
 * to avoid a pointless click. The returned `opened` flag tells the caller
 * whether it is responsible for closing the panel again afterwards.
 */
export async function ensureScreenerOpen(_deps) {
  const d = resolveDeps(_deps);
  const isOpen = () => d.evaluate(`!!document.querySelector('[data-name="screener-topbar-screen-title"]')`);

  if (await isOpen()) {
    return { opened: false };
  }

  await d.click({ by: 'data-name', value: 'screener-dialog-button' });
  const appeared = await waitFor(isOpen, d);
  if (!appeared) {
    throw new Error('Screener panel did not open — TradingView DOM may have changed');
  }
  return { opened: true };
}

/**
 * Dismiss the screener panel.
 *
 * The panel has no close button of its own (its toolbar is Save/Undo/Redo/
 * Settings/Refresh/Maximize/Search). The close affordance sits in the
 * surrounding panel chrome, outside [class*="screenerContainer"], and its
 * aria-label "Close" is NOT unique page-wide — so it is resolved by walking up
 * from the container rather than by a global lookup, which could otherwise
 * dismiss an unrelated dialog.
 */
export async function closeScreenerPanel(_deps) {
  const d = resolveDeps(_deps);
  const res = await d.evaluate(`
    (function() {
      var panel = document.querySelector('[class*="screenerContainer"]');
      if (!panel) { return { ok: true, note: 'already closed' }; }
      var node = panel;
      var btn = null;
      for (var i = 0; i < 5 && node.parentElement && !btn; i++) {
        node = node.parentElement;
        var cands = node.querySelectorAll('button[aria-label="Close"]');
        for (var j = 0; j < cands.length; j++) {
          if (cands[j].offsetParent !== null && !panel.contains(cands[j])) { btn = cands[j]; break; }
        }
      }
      if (!btn) { return { ok: false, reason: 'close_button_not_found' }; }
      btn.click();
      return { ok: true, clicked: true };
    })()
  `);

  if (!res?.ok) {
    throw new Error('Could not close the screener panel — TradingView DOM may have changed');
  }
  if (!res.clicked) {
    return true;
  }

  const gone = await waitFor(
    () => d.evaluate(`!document.querySelector('[class*="screenerContainer"]')`),
    d,
    { maxMs: 5000 }
  );
  if (!gone) {
    throw new Error('Could not close the screener panel — the Close button was clicked but the panel is still open');
  }
  return true;
}

/**
 * Open the "Open screen…" dialog from the active-screen title menu.
 *
 * The menu item has no data-name, and both synthetic .click() and dispatched
 * pointer events silently no-op on it. JS .focus() IS reliable, so the item is
 * activated by focusing its [tabindex="0"] ancestor and sending a real Enter
 * key through CDP. Menu items render as nested duplicate layers sharing the
 * same innerText, so the real target is the visible childless leaf.
 */
export async function openScreenDialog(_deps) {
  const d = resolveDeps(_deps);

  await d.click({ by: 'data-name', value: 'screener-topbar-screen-title' });
  await d.sleep(400);

  const focused = await d.evaluate(`
    (function() {
      var all = document.querySelectorAll('*');
      var leaf = null;
      for (var i = 0; i < all.length; i++) {
        var e = all[i];
        if (e.offsetParent === null) { continue; }
        if (e.children.length !== 0) { continue; }
        if ((e.innerText || '').trim() !== 'Open screen…') { continue; }
        leaf = e;
        break;
      }
      if (!leaf) { return { ok: false, reason: 'menu not open' }; }
      var btn = leaf.closest('[tabindex="0"]');
      if (!btn) { return { ok: false, reason: 'no focusable ancestor' }; }
      btn.focus();
      return { ok: document.activeElement === btn };
    })()
  `);

  if (!focused?.ok) {
    throw new Error('Open screen dialog did not open — TradingView DOM may have changed');
  }

  await d.keyboard({ key: 'Enter' });

  const appeared = await waitFor(
    () => d.evaluate(`!!document.querySelector('[data-name="screener-custom-screens-dialog"]')`),
    d
  );
  if (!appeared) {
    throw new Error('Open screen dialog did not open — TradingView DOM may have changed');
  }
  return true;
}

/**
 * Read every screen listed in the dialog, tagged with its section.
 *
 * The dialog lists MY SCREENS and POPULAR SCREENS together, and each entry has
 * a description leaf as well as a title leaf, so only the hashed title- rows
 * are collected. Walking in document order and tracking the most recent section
 * heading also excludes the dialog's own "Open screen" header, which precedes
 * the first heading and therefore has no section.
 */
export async function readDialogRows(_deps) {
  const d = resolveDeps(_deps);
  const res = await d.evaluate(`
    (function() {
      var dlg = document.querySelector('[data-name="screener-custom-screens-dialog"]');
      if (!dlg) { return { ok: false, reason: 'dialog_gone' }; }
      var all = dlg.querySelectorAll('*');
      var section = null;
      var seen = {};
      var out = [];
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.offsetParent === null) { continue; }
        var text = (el.innerText || '').trim();
        if (!text) { continue; }
        if (el.children.length === 0 && (text === 'MY SCREENS' || text === 'POPULAR SCREENS')) {
          section = text;
          continue;
        }
        if (!section) { continue; }
        if (String(el.className || '').indexOf('title-') < 0) { continue; }
        var key = section + '|' + text;
        if (seen[key]) { continue; }
        seen[key] = true;
        out.push({ name: text, section: section });
      }
      return { ok: true, rows: out };
    })()
  `);

  if (!res?.ok) {
    throw new Error('Open screen dialog closed unexpectedly — TradingView DOM may have changed');
  }
  return res.rows || [];
}

/**
 * Focus the dialog's Search box and type the literal screen name, narrowing
 * the list deterministically before selection.
 */
export async function searchDialog(name, _deps) {
  const d = resolveDeps(_deps);
  const focused = await d.evaluate(`
    (function() {
      var inputs = document.querySelectorAll('input');
      for (var i = 0; i < inputs.length; i++) {
        if (inputs[i].placeholder === 'Search' && inputs[i].offsetParent !== null) {
          inputs[i].focus();
          inputs[i].setSelectionRange(0, inputs[i].value.length);
          return { ok: true };
        }
      }
      return { ok: false };
    })()
  `);

  if (!focused?.ok) {
    throw new Error('Could not focus the screen Search box — TradingView DOM may have changed');
  }

  await d.typeText({ text: String(name) });
  await d.sleep(400);
  return true;
}

/**
 * Read the visible result rows.
 *
 * data-rowkey is the only carrier of the exchange-qualified symbol
 * (e.g. NYSE:NOK) and is returned verbatim — never reduced to a bare ticker.
 * The scroller measurements travel with the rows so completeness is decided in
 * Node, where it can be tested, rather than in the page.
 */
export async function scrapeRows(_deps) {
  const d = resolveDeps(_deps);
  const res = await d.evaluate(`
    (function() {
      var body = document.querySelector('tbody[data-testid="selectable-rows-table-body"]');
      if (!body) { return { ok: false, reason: 'no_results_table' }; }
      var trs = body.querySelectorAll('tr.listRow');
      var rows = [];
      for (var i = 0; i < trs.length; i++) {
        var key = trs[i].getAttribute('data-rowkey');
        if (key) { rows.push(key); }
      }
      var scroller = body.closest('[class*="wrapper"]');
      return {
        ok: true,
        rows: rows,
        scrollHeight: scroller ? scroller.scrollHeight : null,
        clientHeight: scroller ? scroller.clientHeight : null,
      };
    })()
  `);

  if (!res?.ok) {
    throw new Error('Could not read the screener results table — TradingView DOM may have changed');
  }
  return { rows: res.rows || [], scrollHeight: res.scrollHeight, clientHeight: res.clientHeight };
}

/**
 * Poll `scrapeRows` until it returns a non-empty row list or the budget
 * expires, then return the last read.
 *
 * The results table remounts whenever the panel opens or the active screen
 * changes, and for a brief window afterwards it reports zero rows alongside
 * stale scroll measurements (observed live: transient scrollHeight/clientHeight
 * values that do not match the settled DOM). A screen with genuinely zero
 * matches is not a realistic steady state for the screens this tool targets,
 * so a bounded retry resolves the render race without masking a real failure
 * — after the budget expires the last (possibly empty) read is still returned
 * rather than raising an error.
 */
async function waitForResultsReady(d, { maxMs = 3000, interval = 100 } = {}) {
  const ticks = Math.ceil(maxMs / interval);
  let last = { rows: [], scrollHeight: null, clientHeight: null };
  for (let i = 0; i < ticks; i++) {
    last = await scrapeRows(d);
    if (last.rows.length > 0) {
      return last;
    }
    if (i < ticks - 1) {
      await d.sleep(interval);
    }
  }
  return last;
}

/**
 * Dismiss the screen dialog or title menu with Escape so a failed call never
 * strands an overlay open. Best-effort: a cleanup failure must never overwrite
 * the error that caused it.
 */
async function closeScreenMenu(_deps) {
  const d = resolveDeps(_deps);
  try {
    await d.keyboard({ key: 'Escape' });
    await d.sleep(400);
  } catch (_) {}
}

/**
 * Make `screenName` the active screen and return its rows.
 *
 * Omitting screenName scrapes whatever screen is already active, with no menu,
 * dialog or typing — the cheap path for "what is on the screener right now".
 * The panel is restored to the state it was found in on every exit path.
 */
export async function get({ screenName, _deps } = {}) {
  const d = resolveDeps(_deps);
  const wantsSelection = screenName !== undefined && screenName !== null;

  if (wantsSelection && String(screenName).trim() === '') {
    return { success: false, error: 'screenName is required' };
  }
  const target = wantsSelection ? String(screenName).trim() : null;

  let openedByUs = false;
  let note = null;

  try {
    const opened = await ensureScreenerOpen(d);
    openedByUs = opened.opened;

    const active = await getActiveScreenName(d);
    const alreadyActive = target !== null
      && active !== null
      && active.toLowerCase() === target.toLowerCase();

    if (target !== null && !alreadyActive) {
      await openScreenDialog(d);

      // Read the UNFILTERED rows first, before typing narrows the dialog —
      // otherwise a not_found response would report zero available screens.
      const rows = await readDialogRows(d);
      const picked = pickScreenMatch(rows, target);

      if (picked.status === 'not_found') {
        await closeScreenMenu(d);
        return {
          success: false,
          error: 'Screen "' + target + '" not found',
          available: picked.available,
        };
      }
      if (picked.status === 'ambiguous') {
        await closeScreenMenu(d);
        return {
          success: false,
          error: 'Screen "' + target + '" is ambiguous',
          matches: picked.matches,
        };
      }

      // Now narrow the list so the keyboard highlight lands on the right row.
      await searchDialog(target, d);

      // The highlight must move from the search box into the list first —
      // Enter on its own does not select.
      await d.keyboard({ key: 'ArrowDown' });
      await d.keyboard({ key: 'Enter' });
      await d.sleep(400);

      const landed = await waitFor(async () => {
        const now = await getActiveScreenName(d);
        return now !== null && now.toLowerCase() === target.toLowerCase();
      }, d);

      if (!landed) {
        const now = await getActiveScreenName(d);
        await closeScreenMenu(d);
        return {
          success: false,
          error: 'Clicked "' + target + '" but the active screen is "' + now + '"',
        };
      }
    } else if (alreadyActive) {
      note = 'already active';
    }

    const screen = await getActiveScreenName(d);
    const scraped = await waitForResultsReady(d);
    const result = {
      success: true,
      screen,
      count: scraped.rows.length,
      complete: deriveComplete(scraped),
      total: null,
      rows: scraped.rows,
    };
    if (note) {
      result.note = note;
    }
    return result;
  } catch (err) {
    await closeScreenMenu(d);
    return { success: false, error: err.message };
  } finally {
    // Restore the panel to the state it was found in. Best-effort: never let a
    // cleanup failure mask the real result.
    if (openedByUs) {
      try {
        await closeScreenerPanel(d);
      } catch (_) {}
    }
  }
}
