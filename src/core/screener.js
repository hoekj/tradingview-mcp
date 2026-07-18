/**
 * Core screener logic.
 *
 * TradingView exposes no screener API, so selection and scraping are DOM-driven
 * through the screener panel, consistent with core/watchlist.js. Anchors are
 * stable data-name attributes and literal visible text; hashed CSS classes are
 * matched by prefix only, as hints, because they regenerate on every release.
 */

import { evaluate as evaluateImpl } from '../connection.js';
import { click as clickImpl, keyboard as keyboardImpl } from './ui.js';

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
