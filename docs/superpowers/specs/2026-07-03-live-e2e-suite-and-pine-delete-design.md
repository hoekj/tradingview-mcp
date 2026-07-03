# Live E2E Suite + `pine_delete` — Design

## Problem

The current live test suite gives false confidence:

- `tests/e2e.test.js` (~1584 lines) imports **nothing** from `src/core`. It talks to
  TradingView through raw `chrome-remote-interface` and **reimplements every tool inline**
  as `evaluate(...)` expressions. It even keeps its own copy of `FIND_MONACO` (lines
  693-720) carrying the old `editors[0]` bug that caused the recent save outage.
- Because it never calls production code, it hid two classes of real breakage: the
  multi-Monaco save bug, and a set of `ReferenceError` bugs in `chart.js`/`drawing.js`.

Only `tests/watchlist.core.test.js` follows the right pattern: import the real core
module, drive it against a live chart via the `connection.js` singleton, assert
observable end-state, restore.

## Goals

1. **One approach, no duplicated code.** All live tests import `src/core` functions and
   drive them through the default `connection.js` deps. No raw-CDP reimplementation, no
   duplicated `FIND_MONACO`.
2. Add `pine_delete` (core + MCP tool + CLI) so Pine tests are self-cleaning.
3. Real e2e coverage for the fully-feasible categories: read-only reads, restorable
   mutations, the Pine round-trip, drawing, and (env-gated) alerts.
4. Fix the pre-existing `ReferenceError` bugs that block honest coverage.

## Non-goals

- Full behavioral e2e for genuinely infeasible categories (replay, panel-dependent data,
  capture visuals, UI automation, batch). These get a **slimmed smoke** file only.
- Running live e2e in CI. Live tests require TradingView Desktop on `:9222`; they are a
  local/pre-release suite. Mocked unit tests remain the CI gate.

## Confirmed pre-existing bugs (fix in scope)

Both files import `evaluate`/`getChartApi` under aliased names (`_evaluate`/`_getChartApi`)
but several functions call the **unbound bare name**, throwing `ReferenceError` at runtime.
Unchanged since f5ddb8f — long-standing, hidden by the fake e2e suite.

- `src/core/chart.js`: `getVisibleRange` (118), `scrollToDate` (160), `symbolInfo` (199)
- `src/core/drawing.js`: `listDrawings` (47), `getProperties` (59), `removeOne` (88), `clearAll` (109)

**Fix:** convert each to the module's own `_resolve(_deps)` pattern (add `{ _deps } = {}` /
`_deps` to the params, `const { evaluate, getChartApi } = _resolve(_deps)`). This both binds
the names correctly and makes the functions `_deps`-injectable, consistent with the
already-correct functions in the same modules. Implementation begins with a failing test
that reproduces the `ReferenceError` (per systematic-debugging / TDD).

## `pine_delete`

New core function `deleteScript({ name, _deps } = {})` in `src/core/pine.js`.

**Mechanism: native UI trash delete** (chosen over a facade REST call). The facade endpoint
`POST /pine-facade/delete/{id}` was verified live to fully delete the backend script, but it
leaves a stale entry in TradingView's own Open-Script dialog cache until the app reloads.
Driving TradingView's native trash control goes through the app's own flow, so it is
cache-consistent (no ghost). It reuses the exact dialog-opening steps `openScript` already
uses.

Flow:
1. `ensurePineEditorOpen`, then resolve the target from `fetchScriptList`: exact `name`/`title`
   match (case-insensitive), else unique substring. Refuse ambiguous/unmatched names with a
   clear error (never guess — deleting is destructive).
2. Open the Open-Script dialog: click `[data-qa-id="pine-script-title-button"]` →
   `[role="menuitem"]` matching "Open script" → type the name into `input[placeholder="Search"]`.
3. Find the row whose `[data-name="open-script-dialog-item-name"]` text equals the target
   name, then click that row's `[data-name="remove-button"]` (aria-label "Remove"). **These
   `data-name` attributes are the stable selectors** — the row/`itemInfo`/`title` classes are
   hashed (`itemRow-<hash>`) and must not be relied on.
4. Confirm the deletion dialog via `pollForDialog` (extend its confirm regex to also match
   `^delete$` / `^remove$` if the live confirm button uses that copy — established by the e2e
   test against a throwaway script).
5. Verify by re-reading `fetchScriptList` (target absent). If `_trackedOpenScript` referenced
   the deleted slot, clear it. Return `{ success, deleted: true, name, id }`.
- Register `pine_delete` MCP tool (`src/tools/pine.js`) and `tv pine delete` CLI subcommand
  (`src/cli/commands/pine.js`), following the existing registration shapes.
- **Selector coverage:** `pine.core.test.js` exercises the full create→delete round-trip
  against a throwaway slot, which asserts the `data-name` selectors still resolve — so a TV
  update that renames them fails the test loudly rather than silently.

## Test architecture

### Shared harness — `tests/helpers/live.js`

Exports reused by every live file (single source of truth):

- `sleep(ms)`
- `teardown()` → `disconnect()` from `connection.js` (closes the shared CDP socket so
  `node --test` exits).
- `snapshotChart()` / `restoreChart(snap)` → capture & restore symbol / timeframe / type
  via the core `chart` functions.
- small helpers for throwaway resources (e.g. pick a real ticker not currently shown).

No test logic is duplicated across category files; anything shared lives here.

### Category files (feasible — real behavioral assertions, self-cleaning)

- `tests/chart.core.test.js`
  - Read-only: `getState`, `getVisibleRange`, `symbolInfo`, `data.getQuote`, `data.getOhlcv`.
  - Restorable mutations (snapshot/restore in `before`/`after`): `setSymbol`, `setTimeframe`,
    `setType`, `setVisibleRange`, `scrollToDate`, `manageIndicator` add→remove,
    `indicators.setInputs`, `indicators.toggleVisibility`.
- `tests/data.core.test.js`
  - Read-only shape assertions: `getStudyValues`, `getOhlcv({summary:true})`, `getQuote`,
    `getPineLines/Labels/Tables/Boxes` (assert well-formed; may be empty). Skips
    panel-dependent (`getStrategyResults`, `getTrades`, `getEquity`, `getDepth`).
- `tests/pine.core.test.js` — **closes the outage gap**
  - `newScript` → `setSource` → `save` (assert `saved_to` populated + version bump) →
    `getSource` (assert injected marker round-trips) → `smartCompile`/`getErrors` →
    `deleteScript` cleanup. Fully self-cleaning; also deletes the leftover
    `zz_mcp_test_scratch` if present.
- `tests/drawing.core.test.js`
  - `drawShape` (horizontal_line at a real bar) → `listDrawings` (present) → `getProperties`
    → `removeOne` (gone) → `drawShape` again → `clearAll`. Self-cleaning.
- `tests/alerts.core.test.js` — **env-gated** (`TVMCP_ALERT_TESTS=1`, else `t.skip`)
  - `create` (throwaway price) → `list` (present) → `deleteAlerts({delete_all:true})`. Always
    cleans up in `finally`.

### Slimmed smoke — `tests/smoke.core.test.js`

Replaces the retired monolith for the infeasible categories, but **through core** (no raw
CDP, no `FIND_MONACO`). Shallow, side-effect-safe checks:

- Replay: `replay_start` → `replay_status` → `replay_stop` (cleanup in `finally`); env-gate
  if needed.
- Panel-dependent data: call `getStrategyResults`/`getTrades`/`getEquity`/`getDepth`, assert
  each returns a well-formed result **or** skips when its panel/strategy is absent (they
  already degrade gracefully with `{success,...,error}`).
- Capture: `captureScreenshot` → assert a file path is returned and the file exists → remove
  the created file.
- Batch: `batch_run` over 2 symbols → assert shape; restore original symbol.

UI automation keeps its existing `tests/ui.test.js` coverage; not re-smoked here.

The old `tests/e2e.test.js` is deleted; its still-useful smoke intent is preserved by
`smoke.core.test.js` in the one-approach style.

## Harness reliability

- One shared TradingView chart ⇒ live tests must not run concurrently. The live script runs
  with `--test-concurrency=1`.
- Every live file calls `teardown()` (disconnect) in `after`.
- `package.json` scripts:
  - `test:unit` (CI-safe, mocked) — unchanged set + keeps `pine_editor_selection`.
  - `test:e2e` → `node --test --test-concurrency=1` with the live files listed **explicitly**
    (`watchlist.core.test.js chart.core.test.js data.core.test.js pine.core.test.js
    drawing.core.test.js alerts.core.test.js smoke.core.test.js`) — no shell glob, for
    cross-shell/Node portability. Requires TV on `:9222`.
  - `test:all` updated accordingly; destructive/alert paths stay env-gated.

## Testing & verification

- Each core fix and `deleteScript` gets a failing test first (mocked `_deps` where the logic
  is unit-testable, e.g. `deleteScript`'s target-resolution and refusal branches).
- The live category files are the behavioral proof; run locally against TradingView.
- `verification-before-completion`: run `test:unit` (must stay green) and the live `test:e2e`
  against the connected chart; report actual output.

## Risks

- `pine_delete` depends on TradingView DOM (Open-Script dialog + trash control). Mitigated by
  using stable `data-name` selectors and covering the flow in `pine.core.test.js`, which fails
  loudly if TV renames them. The delete-confirmation button copy is unknown until the e2e test
  runs against a throwaway script; `pollForDialog`'s confirm matcher is widened accordingly.
- Live tests depend on chart state (symbol availability, logged-in session) → snapshot/restore
  and skip-guards keep them non-destructive and resilient.
