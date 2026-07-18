# `screener_get_rows` — Design

**Date:** 2026-07-18
**Status:** Approved (design), pending implementation plan

## Summary

Add one MCP tool that makes a named saved screen the active built-in screener and returns its rows as
`EXCH:TICKER[]`. Consumers stop hand-driving `ui_click` / `ui_evaluate` sequences to open, select, verify
and scrape the screener; the tool does all four and reports failure loudly rather than returning rows from
the wrong screen.

The tool is generic — it has no knowledge of any consumer. Its whole contract is
`{ screenName? } -> { success, screen, rows, count, complete, total }`.

## Feasibility (established by live probing, 2026-07-18, TV Desktop 3.2.0)

- **No screener API.** `tv_discover` exposes no screener path; selection is a UI flow. All logic is
  DOM-driven, consistent with `src/core/watchlist.js`.
- **Anchor on stable `data-name` attributes and literal visible text**, never on hashed CSS classes
  (`title-IMAw04Wp`, `screenNameButton-Gf8sWug7`) — these regenerate per TradingView release. Where a
  hashed class is the only handle, treat it as a hint and match on text.
- **Elements without `data-name` do not respond to synthetic `.click()`** nor to dispatched pointer events;
  both silently no-op. JS `.focus()` *is* reliable. Activation is therefore **focus the `[tabindex="0"]`
  ancestor + real keyboard Enter** via CDP.
- **Menu items render as nested duplicate layers** sharing the same `innerText`; the real visible leaf is
  selected with `offsetParent !== null && children.length === 0`.
- **The title-click menu's inline screen list is partial** and must not be used. Probing showed five
  entries where the account has six saved screens (`Most active` was absent). The `Open screen…` dialog is
  the only authoritative list.
- **The dialog has two sections** — `MY SCREENS` (user-saved) and `POPULAR SCREENS` (~20 built-ins) — and
  each entry carries a description leaf as well as a title leaf. Name collisions across sections are
  possible, so matching must be scoped to title rows and must reject ambiguity.
- **No result-count element exists.** A search of the screener panel for match/result/symbol counts and for
  numeric leaf nodes returned nothing. The row total is not observable.
- **Verified idempotent:** clicking `screener-dialog-button` while the screener is already open does not
  toggle it closed. There is therefore no toggle-off; closing needs a separate affordance.
- **The screener panel has no close button of its own.** Its toolbar offers Save/Undo/Redo/Settings/
  Refresh/Maximize/Search only. The close affordance lives in the surrounding panel chrome, outside
  `[class*="screenerContainer"]`: a real `<button>` with `aria-label="Close"` (alongside one labelled
  `Collapse panel`). Clicking it unmounts the container and the results `tbody` entirely — verified.
- **`aria-label="Close"` is not unique** across the page. It must be resolved by proximity to the screener
  panel, not by a global lookup, or a call made while some other dialog is open could close the wrong thing.

### Stable anchors

| Element | Anchor | Notes |
|---|---|---|
| Open-screener button | `data-name="screener-dialog-button"` | toolbar button, aria-label "Screeners" |
| Active-screen title | `data-name="screener-topbar-screen-title"` | `innerText` = active screen name |
| Title menu → "Open screen…" | visible text leaf `Open screen…` → its `[tabindex="0"]` ancestor | no `data-name`; `ui_click by="text"` does not match it |
| Open-screen dialog | `data-name="screener-custom-screens-dialog"` | contains Search input + both sections |
| Search input | visible `input[placeholder="Search"]` | filters the list as you type |
| Screen rows | `[class*="title-"]` within the dialog, visible only | hashed class is a hint; match on `innerText` |
| Result rows | `tbody[data-testid="selectable-rows-table-body"] tr.listRow` | `data-rowkey` = `EXCH:TICKER` |
| Close-panel button | `button[aria-label="Close"]` in the panel chrome **outside** `[class*="screenerContainer"]` | label is not unique page-wide — resolve by proximity |

## Architecture

A new domain module, mirroring `watchlist.js` rather than extending `src/core/ui.js` (already ~350 lines of
generic primitives; a screener flow is domain logic, not a primitive).

- `src/core/screener.js` — public `get({ screenName })`; private `ensureScreenerOpen()`,
  `getActiveScreenName()`, `openScreenDialog()`, `findScreenRows(name)`, `scrapeRows()`,
  `closeScreenMenu()`, `closeScreenerPanel()`
- `src/tools/screener.js` — `registerScreenerTools(server)`
- `src/core/index.js` — `export * as screener from './screener.js'`
- `src/server.js` — call `registerScreenerTools(server)` alongside the existing registrations

Page-JS interpolation uses `safeString()` from `src/connection.js` (as `watchlist.js` does), not
`JSON.stringify`.

## Contract

```js
// success
{ success: true, screen: 'Pre-market most active', count: 8, complete: true, total: null,
  rows: ['NYSE:NOK', 'NASDAQ:SOFI', 'NASDAQ:SMCI', ...] }

// already active — no menu, no dialog, no typing
{ success: true, screen: 'Pre-market most active', note: 'already active', count: 8, ... }
```

`screenName` is **optional**. Omitted → scrape whatever screen is already active, with no selection flow
at all. This keeps the common "what is on the screener right now" case free of UI churn, mirroring
`watchlist.get()`.

`screen` is always the canonical name as read back from the DOM, not the caller's casing.

### Row values

`data-rowkey` is the only carrier of the exchange-qualified symbol (`NYSE:INFY`). Return it verbatim; never
strip the exchange to a bare ticker.

### Completeness

The screener renders only what fits; there is no observable total.

- `count` — number of rows returned
- `complete` — derived: `false` when the scroll wrapper satisfies `scrollHeight > clientHeight + 4`,
  otherwise `true`. No overflow means everything loaded is in the DOM.
- `total` — always `null`. TradingView exposes no count. `null` means "not observable"; it never means zero
  and is never guessed.

This design scrapes only what is rendered and does not scroll. When `complete` is `false` the caller knows
the set is partial and knows exactly how many rows they did receive. It cannot know how many are missing,
because TradingView does not expose that — but it is never told a partial set is whole.

## Flow

1. **`ensureScreenerOpen()`** — if `[data-name="screener-topbar-screen-title"]` is absent, click
   `[data-name="screener-dialog-button"]` and poll for the title to appear. **Returns whether it opened the
   panel**; the caller keeps that flag for step 9.
2. **Short-circuit** — read the active screen name. If `screenName` is omitted, or matches case-insensitively
   after trimming, skip straight to step 8 (scrape); there is nothing to select and nothing to verify.
   Avoids redundant load time and UI churn.
3. **Open the title menu** — `click({ by:'data-name', value:'screener-topbar-screen-title' })`, `sleep(400)`.
4. **Open the dialog** — `evaluate` to find the visible `Open screen…` text leaf, climb to its
   `[tabindex="0"]` ancestor, `.focus()`; then `keyboard({ key:'Enter' })`. Poll for
   `[data-name="screener-custom-screens-dialog"]`.
5. **Search the literal name** — `evaluate` to focus and select-all the visible `input[placeholder="Search"]`,
   then `typeText({ text: screenName })`, `sleep(400)`.
6. **Strict structural guard, then select** — `evaluate` the visible `[class*="title-"]` rows within the
   dialog, each tagged with its section (`MY SCREENS` / `POPULAR SCREENS`) from the preceding section
   heading. Require **exactly one** case-insensitive exact match:
   - 0 matches → return `not_found` with `available[]`
   - >1 matches → return `ambiguous` with `matches[]`
   - exactly 1 → `keyboard({ key:'ArrowDown' })` then `keyboard({ key:'Enter' })`. `Enter` alone does not
     select; the highlight must first move from the search box into the list.
7. **Verify by readback** — poll until the dialog is closed and the title equals the requested name. A
   mismatch is a failure, not a warning.
8. **Scrape** — collect `data-rowkey` from the result rows and derive `complete`.
9. **`closeScreenerPanel()` — restore the prior panel state.** If step 1 opened the panel, close it; if the
   user already had it open, leave it open. Runs on **every** exit path, success or failure, in a
   `try/catch` so a close failure never masks the real result. Resolve the close button by proximity —
   locate `[class*="screenerContainer"]`, walk up to the panel chrome, and take the
   `button[aria-label="Close"]` there — never a page-wide `aria-label` lookup. Verify the container is gone.
10. **Return.**

Matching is exact (case-insensitive, trimmed), never substring. A substring match on a two-section list is
how a caller silently gets the wrong screen.

## Error handling

All failures **return** `{ success: false, error, ... }`; the core never throws for expected conditions.
This follows `watchlist.select` (`src/core/watchlist.js:85-165`) — a returned error can carry `available[]`,
which tells the caller what they could have asked for. The tool layer keeps the standard
`try/catch → jsonResult({ success:false, error: err.message }, true)` wrapper for genuine exceptions.

| Condition | Return |
|---|---|
| `screenName` provided but blank | `{ success:false, error:'screenName is required' }` |
| No matching row | `{ success:false, error:'Screen "X" not found', available:[{name,section}] }` |
| More than one matching row | `{ success:false, error:'Screen "X" is ambiguous', matches:[{name,section}] }` |
| Dialog did not open | `{ success:false, error:'Open screen dialog did not open — TradingView DOM may have changed' }` |
| Screener panel did not open | `{ success:false, error:'Screener panel did not open — TradingView DOM may have changed' }` |
| Title ≠ requested after select | `{ success:false, error:'Clicked "X" but the active screen is "Y"' }` |

DOM-change messages are worded distinctly from bad-name messages, so a TradingView release does not
masquerade as a caller typo.

**Cleanup:** every failure path calls `closeScreenMenu()` — Escape via CDP inside `try/catch`, then
`sleep(400)` — so a failed call never leaves a dialog open. This mirrors `escapeRecover()` in
`src/tools/watchlist.js:7-14`. It then runs the same `closeScreenerPanel()` restore as the success path
(step 9), so an aborted call does not strand an open screener either.

Both cleanups are best-effort and wrapped in `try/catch`: a failure to tidy the UI is never allowed to
overwrite the error that actually caused the failure.

## Waits

Fixed `sleep(400)` after UI mutations, matching `watchlist.js`. The two steps that gate correctness — the
dialog appearing and the title changing — use a bounded poll modelled on `waitForLayoutName`
(`src/core/ui.js:165`): `{ maxMs: 10000, interval: 250 }`, returning `false` on timeout so the caller
produces the DOM-changed error rather than hanging.

## Tool registration

```js
server.tool('screener_get_rows',
  'Make the named saved screen the active screener and return its rows as EXCH:TICKER[]. ' +
  'Omit screenName to scrape the currently active screen.',
  { screenName: z.string().optional().describe('Exact saved screen name, e.g. "Pre-market most active"') },
  async ({ screenName }) => {
    try { return jsonResult(await core.screener.get({ screenName })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
```

Schema is a raw zod shape with `.describe()` on every field, per the existing tools.

## Testing

**`tests/screener_deps.test.js`** — `test:unit`, dependency-injected, no browser. Covers the pure logic:
exact-match selection, zero-match, ambiguous-match across sections, `available[]` assembly, `complete`
derivation from overflow numbers, blank-name validation.

**`tests/screener.core.test.js`** — `test:e2e`, live, added to the `test:e2e` script in `package.json`.
Modelled on `tests/watchlist.core.test.js`: imports the core module directly, `after` calls `disconnect()`,
every assert carries a message, `sleep(300-500)` after mutations.

Non-destructive by construction: `before` snapshots the active screen, and any test that switches screens
restores it in a `finally`.

Cases:
- happy path returns `success`, `screen === requested`, non-empty `rows`, `count === rows.length`,
  `complete` boolean, `total === null`
- every row matches `/^[A-Z]+:[A-Z0-9.]+$/`
- second consecutive call returns `note: 'already active'` and does not throw
- omitted `screenName` returns the active screen's rows
- bogus name (`'__no_such_screen__'`) returns `success:false` with a non-empty `available[]`
- opening from a **closed** screener panel works (close the panel first, then call)
- **panel state is restored:** called with the panel closed, it is closed again afterwards; called with the
  panel already open, it is still open afterwards
- the UI is left with no dialog open after a failed call, and the panel state is restored on that path too

Live prerequisites: TV Desktop up with CDP on 9222, and `Pre-market most active` saved in MY SCREENS.

## Non-goals

- **Scrolling to load more rows.** Deliberately out of scope; `complete` reports the shortfall instead. A
  scroll-to-exhaustion mode can be added later behind a `limit` parameter without changing this contract.
- **Reading screener columns.** Rows are symbols only. Column data belongs in a separate tool if wanted.
- **Creating, renaming, or saving screens.** Read and select only.
- **Re-applying filters.** The screen's configuration is owned by the user; the tool takes its output as-is.
