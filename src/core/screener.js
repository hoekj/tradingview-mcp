/**
 * Core screener logic.
 *
 * TradingView exposes no screener API, so selection and scraping are DOM-driven
 * through the screener panel, consistent with core/watchlist.js. Anchors are
 * stable data-name attributes and literal visible text; hashed CSS classes are
 * matched by prefix only, as hints, because they regenerate on every release.
 */

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
