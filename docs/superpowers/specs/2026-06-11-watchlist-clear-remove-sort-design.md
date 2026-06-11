# Watchlist: clear, remove, sort — Design

**Date:** 2026-06-11
**Status:** Approved (design), pending implementation plan

## Summary

Extend the TradingView MCP watchlist tools with three new functions:

- `watchlist_remove(symbol)` — remove a single symbol from the active list (round-trips with `watchlist_add`).
- `watchlist_clear(expect_list?)` — remove all symbols from the active list; if `expect_list` is given, refuse unless the active list name matches.
- `watchlist_sort(symbols[])` — reorder the active list to match a caller-supplied array.

## Feasibility (established via live probing)

- **No usable internal watchlist API.** `TradingViewApi.watchlist()` throws `"not implemented"` and `_watchlistApiDeferredPromise` is `null` even with the watchlist widget mounted. All three functions must be **DOM-driven**, consistent with the existing `get()` / `add()`.
- **Symbol rows** are reliably identified by `data-symbol-full` (e.g. `NYSE:NOK`).
- **Per-row remove:** each row contains a hover-reveal remove button matched by `[class*="removeButton"]`. Clicking it removes that one symbol. No context menu required.
- **No bulk "remove all"** affordance was found in the row context menu, so `clear` loops the per-row remove.
- **Active list name** is readable from `[data-name="watchlists-button"]` (probe returned `"Today"`). This enables the `expect_list` guard.
- The watchlist tab must be **activated first** (the right panel may be showing alerts or another widget).

## Architecture

All logic lives in `src/core/watchlist.js`, DOM-driven via the existing `evaluate` / CDP `Input` plumbing.

### Shared helpers (DRY refactor of existing `add()`)

- **`ensureWatchlistOpen()`** — extracted from the panel-activation logic currently inlined in `add()`. Activates the watchlist tab if not already active and waits for it to mount. Reused by `add`, `remove`, `clear`, and `sort`.
- **`normalizeSymbol(s)`** — `get()` returns full symbols (`NYSE:NOK`) while callers may pass `NOK`. Matching is case-insensitive: compare the full symbol, then fall back to comparing the part after `:`.

### `get()` enhancement

`get()` will additionally return `active_list` (the active list name read from `[data-name="watchlists-button"]`). `clear` needs this and it is cheap to surface for all callers.

## Functions

### `remove({ symbol })` — idempotent

1. `ensureWatchlistOpen()`.
2. Find the row whose `data-symbol-full` matches `symbol` (via `normalizeSymbol`).
3. **Not found** → `{ success: true, removed: false, note: "<symbol> not in active list" }` (idempotent — safe to call blindly in loops).
4. **Found** → click the row's `[class*="removeButton"]`, verify the row is gone → `{ success: true, removed: true, symbol }`.

### `clear({ expect_list })` — guarded

1. `ensureWatchlistOpen()`.
2. Read the active list name. If `expect_list` is provided and does not match (case-insensitive, trimmed) → refuse: `{ success: false, error: "Active list is '<name>', expected '<expect_list>' — refusing to clear" }`. **No mutation occurs.**
3. Loop: repeatedly click the first remaining row's `removeButton` until no rows remain. Bounded by a max-iteration cap (200) with a short wait between iterations, to avoid an infinite loop on a stuck DOM.
4. Return `{ success: true, cleared: true, removed_count, list }`. An already-empty list returns `removed_count: 0`.

### `sort({ symbols })` — exact permutation, via clear + re-add

1. `ensureWatchlistOpen()`; read current symbols via `get()`.
2. **Validate exact permutation:** the normalized input set must equal the current symbol set, with no duplicates in the input. On mismatch → refuse with specifics: `{ success: false, error, missing: [...], extra: [...] }`. **No mutation occurs if validation fails.**
3. `clear()` internally (no `expect_list` guard — the symbol set was already validated).
4. Re-add each symbol in array order via `add()`.
5. Verify the final order matches the input → `{ success: true, sorted: true, order }`.

## Error handling

Per project rules:

- Defensive braces on all single-line `if` statements.
- No silently swallowed exceptions; errors are logged or returned to the caller.
- Validation-message style for refusals.
- The same Escape-key recovery `add()` performs on failure, so a half-open symbol-search box is never left stuck.

## Surface area

- **MCP tools** (`src/tools/watchlist.js`): register `watchlist_remove`, `watchlist_clear`, `watchlist_sort` with zod schemas and the existing error-recovery wrapper.
- **CLI** (`src/cli/commands/watchlist.js`): add `remove <symbol>`, `clear [--expect <name>]`, and `sort <sym1> <sym2> ...` subcommands.
- **Docs:** update the watchlist section of `CLAUDE.md`, the `README`, and the tool count.

## Testing

Live e2e tests in `tests/e2e.test.js`:

- **Round-trip:** `add` a symbol, then `remove` it; assert it is gone.
- **Guard:** `clear` with a wrong `expect_list` refuses (no mutation); `clear` with the correct name empties the list.
- **Sort:** reorder a valid permutation and assert the new order; assert a mismatched array is rejected with `missing` / `extra` and leaves the list unchanged.

## Known limitation

`sort` (clear + re-add) operates on symbols only. If the active list contains **section dividers**, they are lost. This is documented behavior; full section preservation would require the drag-and-drop approach, which was considered and ruled out as too fragile.
