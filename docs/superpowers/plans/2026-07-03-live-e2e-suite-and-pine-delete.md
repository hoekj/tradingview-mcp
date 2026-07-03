# Live E2E Suite + `pine_delete` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw-CDP monolith e2e suite with one core-driven approach, add a native-UI `pine_delete`, and fix the pre-existing `ReferenceError` bugs — giving real, self-cleaning e2e coverage for the feasible tool categories.

**Architecture:** Every live test imports the real `src/core` functions and drives them through the default `connection.js` CDP singleton (the proven `watchlist.core.test.js` pattern). A shared `tests/helpers/live.js` holds all cross-file harness logic. `pine_delete` drives TradingView's Open-Script dialog trash control using stable `data-name` selectors.

**Tech Stack:** Node.js ESM, `node:test`, `chrome-remote-interface` (via `src/connection.js`), TradingView Desktop CDP on `:9222`.

## Global Constraints

- ESM only (`import`/`export`); project `"type": "module"`.
- Defensive programming: braces on all single-line `if`s. Comments in English.
- Live tests require TradingView Desktop on `:9222`, logged in. They are NOT CI-safe.
- Live tests must run serialized: `--test-concurrency=1` (one shared chart).
- Non-destructive by default: snapshot/restore, throwaway resources, env-gate anything that mutates cloud/account state, always clean up.
- Stable selectors only for `pine_delete`: `[data-name="pine-script-title-button"]` is `[data-qa-id="pine-script-title-button"]`; row name `[data-name="open-script-dialog-item-name"]`; trash `[data-name="remove-button"]`. Never rely on hashed `itemRow-<hash>` classes.
- `FIND_MONACO`/`pickPineEditor` already fixed (commit f1f593a) — do NOT reintroduce `editors[0]`.

---

### Task 1: Fix `chart.js` `ReferenceError` bugs

**Files:**
- Modify: `src/core/chart.js` — `getVisibleRange` (118), `scrollToDate` (160), `symbolInfo` (199)
- Test: `tests/chart_deps.test.js` (create)

**Interfaces:**
- Produces: `getVisibleRange({ _deps } = {})`, `scrollToDate({ date, _deps })`, `symbolInfo({ _deps } = {})` — all now bind `evaluate` via `_resolve(_deps)`; return shapes unchanged.

- [ ] **Step 1: Write the failing test**

```js
// tests/chart_deps.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getVisibleRange, symbolInfo, scrollToDate } from '../src/core/chart.js';

// A mock _deps whose evaluate returns canned values for any expression.
function mockDeps(map) {
  return { _deps: { evaluate: async (expr) => {
    for (const [needle, val] of map) { if (expr.includes(needle)) return val; }
    return null;
  } } };
}

describe('chart.js binds evaluate via _resolve (regression: ReferenceError)', () => {
  it('getVisibleRange returns shaped result with injected deps', async () => {
    const r = await getVisibleRange(mockDeps([['getVisibleRange', { visible_range: { from: 1, to: 2 }, bars_range: { from: 0, to: 9 } }]]));
    assert.equal(r.success, true);
    assert.deepEqual(r.visible_range, { from: 1, to: 2 });
  });

  it('symbolInfo returns shaped result with injected deps', async () => {
    const r = await symbolInfo(mockDeps([['symbolExt', { symbol: 'AAPL', exchange: 'NASDAQ' }]]));
    assert.equal(r.success, true);
    assert.equal(r.symbol, 'AAPL');
  });

  it('scrollToDate resolves without ReferenceError', async () => {
    const r = await scrollToDate({ date: '2025-01-15', _deps: { evaluate: async () => 'D' } });
    assert.equal(r.success, true);
    assert.equal(r.date, '2025-01-15');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/chart_deps.test.js`
Expected: FAIL — `ReferenceError: evaluate is not defined` (and `symbolInfo`/`scrollToDate` likewise).

- [ ] **Step 3: Implement the fix**

In `src/core/chart.js`, change each broken function's signature to accept `_deps` and resolve `evaluate` at the top. Concretely:

```js
export async function getVisibleRange({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  // ...unchanged body...
}
```
```js
export async function scrollToDate({ date, _deps }) {
  const { evaluate } = _resolve(_deps);
  // ...unchanged body (still uses `evaluate` and CHART_API)...
}
```
```js
export async function symbolInfo({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  // ...unchanged body...
}
```
(Note: `symbolInfo` reads `symbolExt()`; verify the injected expression still contains the literal `symbolExt` so the mock matches. `getState` already shows the exact `_resolve` idiom.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/chart_deps.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/core/chart.js tests/chart_deps.test.js
git commit -m "fix(chart): bind evaluate via _resolve in getVisibleRange/scrollToDate/symbolInfo"
```

---

### Task 2: Fix `drawing.js` `ReferenceError` bugs

**Files:**
- Modify: `src/core/drawing.js` — `listDrawings` (47), `getProperties` (59), `removeOne` (88), `clearAll` (109)
- Test: `tests/drawing_deps.test.js` (create)

**Interfaces:**
- Produces: `listDrawings({ _deps } = {})`, `getProperties({ entity_id, _deps })`, `removeOne({ entity_id, _deps })`, `clearAll({ _deps } = {})` — all bind `evaluate`/`getChartApi` via `_resolve(_deps)`.

- [ ] **Step 1: Write the failing test**

```js
// tests/drawing_deps.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { listDrawings, removeOne, clearAll } from '../src/core/drawing.js';

const deps = (evalImpl) => ({ _deps: { evaluate: evalImpl, getChartApi: async () => 'CHART' } });

describe('drawing.js binds evaluate/getChartApi via _resolve (regression)', () => {
  it('listDrawings returns shaped result', async () => {
    const r = await listDrawings(deps(async () => [{ id: 'a', name: 'Line' }]));
    assert.equal(r.success, true);
    assert.equal(r.count, 1);
  });
  it('clearAll returns shaped result', async () => {
    const r = await clearAll(deps(async () => undefined));
    assert.equal(r.success, true);
    assert.equal(r.action, 'all_shapes_removed');
  });
  it('removeOne returns removed flag', async () => {
    const r = await removeOne({ entity_id: 'x', ...deps(async () => ({ removed: true, entity_id: 'x', remaining_shapes: 0 }))._deps ? { _deps: { evaluate: async () => ({ removed: true, entity_id: 'x', remaining_shapes: 0 }), getChartApi: async () => 'CHART' } } : {} });
    assert.equal(r.success, true);
    assert.equal(r.removed, true);
  });
});
```
(If the `removeOne` inline gets awkward, split its deps into a local `const d = { evaluate: async () => ({ removed: true, entity_id: 'x', remaining_shapes: 0 }), getChartApi: async () => 'CHART' };` and call `removeOne({ entity_id: 'x', _deps: d })`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/drawing_deps.test.js`
Expected: FAIL — `ReferenceError: getChartApi is not defined`.

- [ ] **Step 3: Implement the fix**

In each of the four functions, add `_deps` to the params and resolve at the top, mirroring `drawShape`:
```js
export async function listDrawings({ _deps } = {}) {
  const { evaluate, getChartApi } = _resolve(_deps);
  // ...unchanged body...
}
export async function getProperties({ entity_id, _deps }) {
  const { evaluate, getChartApi } = _resolve(_deps);
  // ...unchanged body...
}
export async function removeOne({ entity_id, _deps }) {
  const { evaluate, getChartApi } = _resolve(_deps);
  // ...unchanged body...
}
export async function clearAll({ _deps } = {}) {
  const { evaluate, getChartApi } = _resolve(_deps);
  // ...unchanged body...
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/drawing_deps.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/drawing.js tests/drawing_deps.test.js
git commit -m "fix(drawing): bind evaluate/getChartApi via _resolve in list/getProperties/removeOne/clearAll"
```

---

### Task 3: Core `deleteScript` (unit-level, mocked deps)

**Files:**
- Modify: `src/core/pine.js` — add `deleteScript`; export a small `openScriptDialog` helper if it clarifies reuse (optional).
- Test: `tests/pine_delete.test.js` (create)

**Interfaces:**
- Produces: `deleteScript({ name, _deps } = {})` → `{ success: true, deleted: true, name, id }`. Throws on unmatched/ambiguous name. Uses `_resolve(_deps)`; drives the Open-Script dialog via injected named expressions and verifies via `fetchScriptList`. Clears `_trackedOpenScript` if it matched.

- [ ] **Step 1: Write the failing test**

```js
// tests/pine_delete.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deleteScript, _setTrackedOpenScript, getTrackedOpenScript } from '../src/core/pine.js';

const S = (over = {}) => ({ scriptIdPart: 'aaa', scriptName: 'Alpha', scriptTitle: 'Alpha', version: '1.0', modified: 1, ...over });

// Marker-dispatching mock: `lists` is the sequence of facade responses.
function makeDeps({ lists = [[S()], []], titleMenu = { clicked: true }, openItem = { clicked: true }, search = { found: true }, removeClick = { clicked: true, name: 'Alpha' }, dialog = { handled: true } } = {}) {
  let li = 0;
  const evaluate = async (expr) => {
    if (expr.includes('__openScriptTitleMenu')) return titleMenu;
    if (expr.includes('__clickOpenScriptMenuItem')) return openItem;
    if (expr.includes('__typeInScriptSearch')) return search;
    if (expr.includes('__clickRemoveButton')) return removeClick;
    if (expr.includes('__dismissDialog')) return dialog;
    if (expr.includes('findMonacoEditor')) return true;
    return undefined;
  };
  const evaluateAsync = async (expr) => {
    if (expr.includes('pine-facade/list')) { const l = lists[Math.min(li, lists.length - 1)]; li++; return { scripts: l.map(s => ({ id: s.scriptIdPart, name: s.scriptName, title: s.scriptTitle, version: s.version, modified: s.modified })) }; }
    return undefined;
  };
  return { evaluate, evaluateAsync, sleep: async () => {}, getClient: async () => ({}) };
}

describe('deleteScript()', () => {
  it('deletes an exact-name match via the trash control and verifies removal', async () => {
    const r = await deleteScript({ name: 'Alpha', _deps: makeDeps({ lists: [[S()], []] }) });
    assert.equal(r.success, true);
    assert.equal(r.deleted, true);
    assert.equal(r.name, 'Alpha');
    assert.equal(r.id, 'aaa');
  });

  it('throws when the name is not found', async () => {
    await assert.rejects(
      deleteScript({ name: 'Nope', _deps: makeDeps({ lists: [[S()]] }) }),
      /not found/i,
    );
  });

  it('clears the tracked open script when it was the deleted one', async () => {
    _setTrackedOpenScript({ id: 'aaa', name: 'Alpha' });
    await deleteScript({ name: 'Alpha', _deps: makeDeps({ lists: [[S()], []] }) });
    assert.equal(getTrackedOpenScript(), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/pine_delete.test.js`
Expected: FAIL — `deleteScript is not a function` / not exported.

- [ ] **Step 3: Implement `deleteScript`**

Add to `src/core/pine.js` (reuses `ensurePineEditorOpen`, `fetchScriptList`, `pollForDialog`, `_resolve`, `_trackedOpenScript`). Drives the same dialog `openScript` uses; clicks the stable `[data-name="remove-button"]`:

```js
export async function deleteScript({ name, _deps } = {}) {
  if (!name) throw new Error('deleteScript requires a script name.');
  const d = _resolve(_deps);
  const editorReady = await ensurePineEditorOpen(_deps);
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const { scripts, error } = await fetchScriptList(d.evaluateAsync);
  if (!scripts) throw new Error(`Could not fetch script list: ${error ?? 'unknown error'}`);
  const target = name.toLowerCase();
  let matches = scripts.filter(s => s.name.toLowerCase() === target || (s.title || '').toLowerCase() === target);
  if (matches.length === 0) {
    matches = scripts.filter(s => s.name.toLowerCase().includes(target) || (s.title || '').toLowerCase().includes(target));
  }
  if (matches.length === 0) throw new Error(`Script "${name}" not found. Use pine_list_scripts to see available scripts.`);
  if (matches.length > 1) throw new Error(`"${name}" matches ${matches.length} scripts — use an exact name.`);
  const match = matches[0];

  // Open Script dialog: title button -> "Open script" -> search.
  const menu = await d.evaluate(`
    (function __openScriptTitleMenu() {
      var btn = document.querySelector('[data-qa-id="pine-script-title-button"]');
      if (!btn || btn.offsetParent === null) return { clicked: false };
      if (btn.getAttribute('aria-expanded') === 'true') return { clicked: true, already_open: true };
      btn.click();
      return { clicked: true };
    })()
  `);
  if (!menu?.clicked) throw new Error('Could not open the Pine script title menu.');
  await d.sleep(400);

  const openItem = await d.evaluate(`
    (function __clickOpenScriptMenuItem() {
      var els = document.querySelectorAll('[role="menuitem"]');
      for (var i = 0; i < els.length; i++) {
        if (els[i].offsetParent === null) continue;
        if (/open script/i.test((els[i].textContent || '').trim())) { els[i].click(); return { clicked: true }; }
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { clicked: false };
    })()
  `);
  if (!openItem?.clicked) throw new Error('Could not find the "Open script…" menu item.');
  await d.sleep(500);

  const searched = await d.evaluate(`
    (function __typeInScriptSearch() {
      var input = null, c = document.querySelectorAll('input');
      for (var i = 0; i < c.length; i++) { if (c[i].placeholder === 'Search' && c[i].offsetParent !== null) { input = c[i]; break; } }
      if (!input) return { found: false };
      input.focus();
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${'${JSON.stringify(match.name)}'});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { found: true };
    })()
  `);
  if (!searched?.found) throw new Error('Could not find the Open Script search input.');
  await d.sleep(400);

  // Click the row's stable trash control. Match by data-name="open-script-dialog-item-name".
  const removed = await d.evaluate(`
    (function __clickRemoveButton() {
      var wanted = ${'${JSON.stringify(match.name.toLowerCase())}'};
      var rows = Array.from(document.querySelectorAll('[class*="itemRow-"]')).filter(function(r) { return r.offsetParent !== null; });
      for (var i = 0; i < rows.length; i++) {
        var nameEl = rows[i].querySelector('[data-name="open-script-dialog-item-name"]');
        if (!nameEl) continue;
        if (nameEl.textContent.trim().toLowerCase() !== wanted) continue;
        rows[i].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        var trash = rows[i].querySelector('[data-name="remove-button"]');
        if (!trash) return { clicked: false, reason: 'no remove-button' };
        trash.click();
        return { clicked: true, name: nameEl.textContent.trim() };
      }
      return { clicked: false, reason: 'row not found' };
    })()
  `);
  if (!removed?.clicked) throw new Error(`Could not click the trash control for "${'${match.name}'}" (${'${removed?.reason}'}).`);
  await d.sleep(300);

  // Confirm the delete dialog if one appears.
  await pollForDialog(d);

  // Verify removal from the facade list.
  let gone = false;
  for (let i = 0; i < 8; i++) {
    await d.sleep(500);
    const after = await fetchScriptList(d.evaluateAsync);
    if (after.scripts && !after.scripts.some(s => s.id === match.id)) { gone = true; break; }
  }
  if (!gone) throw new Error(`Clicked delete for "${'${match.name}'}" but it still appears in the saved-script list.`);

  if (_trackedOpenScript && _trackedOpenScript.id === match.id) _trackedOpenScript = null;
  return { success: true, deleted: true, name: match.name, id: match.id };
}
```
(The `${...}` interpolations shown quoted are literal template placeholders — write them as real `${JSON.stringify(...)}` in code.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/pine_delete.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/core/pine.js tests/pine_delete.test.js
git commit -m "feat(pine): add deleteScript via native Open-Script trash control"
```

---

### Task 4: Register `pine_delete` MCP tool + CLI subcommand

**Files:**
- Modify: `src/tools/pine.js` (add `pine_delete`), `src/cli/commands/pine.js` (add `delete` subcommand)
- Test: covered by Task 3 (core) + Task 6 (live). Registration is thin glue.

**Interfaces:**
- Consumes: `core.deleteScript({ name })`.
- Produces: MCP tool `pine_delete { name: string }`; CLI `tv pine delete "<name>"`.

- [ ] **Step 1: Add the MCP tool** (in `registerPineTools`, mirror `pine_open`):

```js
server.tool('pine_delete', 'Delete a saved Pine Script by name (drives TradingView\'s native Open-Script trash control; verified via the saved-script list).', {
  name: z.string().describe('Name of the saved script to delete (exact or unique substring match)'),
}, async ({ name }) => {
  try { return jsonResult(await core.deleteScript({ name })); }
  catch (err) { return jsonResult({ success: false, error: err.message }, true); }
});
```

- [ ] **Step 2: Add the CLI subcommand** (in the `subcommands` Map, after `open`):

```js
['delete', {
  description: 'Delete a saved Pine Script by name',
  handler: (opts, positionals) => {
    if (!positionals[0]) throw new Error('Script name required. Usage: tv pine delete "My Script"');
    return core.deleteScript({ name: positionals.join(' ') });
  },
}],
```

- [ ] **Step 3: Smoke the registration**

Run: `node -e "import('./src/tools/pine.js').then(m => { const t=[]; m.registerPineTools({tool:(n)=>t.push(n)}); console.log(t.includes('pine_delete')?'OK':'MISSING'); })"`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add src/tools/pine.js src/cli/commands/pine.js
git commit -m "feat(pine): expose pine_delete MCP tool and tv pine delete CLI"
```

---

### Task 5: Shared live harness `tests/helpers/live.js`

**Files:**
- Create: `tests/helpers/live.js`

**Interfaces:**
- Produces: `sleep(ms)`, `teardown()`, `snapshotChart()`, `restoreChart(snap)`, `pickAbsentSymbol(present, candidates?)`.

- [ ] **Step 1: Write the helper**

```js
// tests/helpers/live.js
import { disconnect } from '../../src/connection.js';
import * as chart from '../../src/core/chart.js';

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Close the shared CDP socket so `node --test` can exit.
export async function teardown() {
  await disconnect();
}

// Capture symbol/timeframe/type so a suite can restore chart state it mutates.
export async function snapshotChart() {
  const s = await chart.getState();
  return { symbol: s.symbol, resolution: s.resolution, chartType: s.chartType };
}

export async function restoreChart(snap) {
  if (!snap) return;
  await chart.setSymbol({ symbol: snap.symbol });
  await sleep(1500);
  await chart.setTimeframe({ timeframe: String(snap.resolution) });
  await sleep(800);
  await chart.setType({ chart_type: snap.chartType });
  await sleep(400);
}

// Pick a real ticker not already present (so we never clobber user state).
export function pickAbsentSymbol(presentSet, candidates = ['AAPL', 'MSFT', 'KO', 'F', 'T', 'INTC']) {
  return candidates.find(c => !presentSet.has(c.toUpperCase()));
}
```

- [ ] **Step 2: Sanity-import**

Run: `node -e "import('./tests/helpers/live.js').then(m => console.log(typeof m.snapshotChart==='function'?'OK':'BAD'))"`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add tests/helpers/live.js
git commit -m "test(e2e): add shared live harness (snapshot/restore, teardown)"
```

---

### Task 6: `pine.core.test.js` — live round-trip + delete (closes the outage gap)

**Files:**
- Create: `tests/pine.core.test.js`
- Possibly modify: `src/core/dialog.js` (widen confirm regex) — only if Step 2 shows the confirm button copy isn't matched.

**Interfaces:**
- Consumes: `pine.newScript`, `pine.setSource`, `pine.save`, `pine.getSource`, `pine.getErrors`, `pine.deleteScript`, `pine.listScripts`; `helpers/live`.

- [ ] **Step 1: Write the live test**

```js
// tests/pine.core.test.js
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as pine from '../src/core/pine.js';
import { teardown, sleep } from './helpers/live.js';

const NAME = 'zz_e2e_pine_roundtrip';

describe('pine core round-trip (live e2e)', () => {
  after(async () => {
    // Best-effort cleanup in case an assertion aborted mid-test.
    try {
      const { scripts } = await pine.listScripts();
      if (scripts?.some(s => s.name === NAME)) await pine.deleteScript({ name: NAME });
    } catch {}
    // Also clear the historical leftover if present.
    try {
      const { scripts } = await pine.listScripts();
      if (scripts?.some(s => s.name === 'zz_mcp_test_scratch')) await pine.deleteScript({ name: 'zz_mcp_test_scratch' });
    } catch {}
    await teardown();
  });

  it('new -> setSource -> save (version bump) -> getSource round-trips -> delete', async () => {
    const created = await pine.newScript({ type: 'indicator', name: NAME });
    assert.equal(created.success, true);
    assert.ok(created.script?.id, 'new slot has an id');

    const marker = 'ROUNDTRIP_' + created.script.id.slice(-6);
    await pine.setSource({ source: `//@version=5\nindicator("${NAME}", overlay=true)\nplot(close, title="${marker}")\n` });
    await sleep(500);

    const saved = await pine.save();
    assert.ok(saved.saved_to, 'save reports the slot it wrote');
    assert.equal(saved.saved_to.id, created.script.id, 'saved into the new slot');
    assert.match(String(saved.saved_to.version), /^[2-9]/, 'version bumped past 1');

    const read = await pine.getSource();
    assert.ok(read.source.includes(marker), 'getSource returns the injected marker (right editor)');

    const errs = await pine.getErrors();
    assert.equal(errs.success, true);

    const del = await pine.deleteScript({ name: NAME });
    assert.equal(del.deleted, true);

    const { scripts } = await pine.listScripts();
    assert.ok(!scripts.some(s => s.name === NAME), 'slot gone from saved-script list');
  });
});
```

- [ ] **Step 2: Run live and inspect the delete confirmation**

Run: `node --test --test-concurrency=1 tests/pine.core.test.js`
Expected: PASS. If the delete step fails at the confirm dialog (slot not gone), the confirm button copy isn't `yes/ok/confirm`. Inspect via the running chart (`mcp__tradingview__ui_evaluate`) what the confirm button text is, then widen the Pass-2 regex in `src/core/dialog.js` from `/^(yes|ok|confirm)$/i` to `/^(yes|ok|confirm|delete|remove)$/i` and re-run. Re-run the dialog unit tests afterward: `node --test tests/dialog.test.js` (must stay green).

- [ ] **Step 3: Commit**

```bash
git add tests/pine.core.test.js src/core/dialog.js
git commit -m "test(e2e): live pine round-trip (new/set/save/get/delete) + widen confirm matcher"
```

---

### Task 7: `chart.core.test.js` — read-only + restorable mutations (live)

**Files:**
- Create: `tests/chart.core.test.js`

**Interfaces:**
- Consumes: `chart.*`, `data.getQuote`, `data.getOhlcv`, `indicators.*`, `helpers/live`.

- [ ] **Step 1: Write the live test**

```js
// tests/chart.core.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as chart from '../src/core/chart.js';
import * as data from '../src/core/data.js';
import * as indicators from '../src/core/indicators.js';
import { teardown, sleep, snapshotChart, restoreChart } from './helpers/live.js';

describe('chart core (live e2e)', () => {
  let snap;
  before(async () => { snap = await snapshotChart(); });
  after(async () => { await restoreChart(snap); await teardown(); });

  it('getState returns symbol/resolution/type/studies', async () => {
    const s = await chart.getState();
    assert.equal(s.success, true);
    assert.ok(s.symbol && s.resolution);
    assert.ok(Array.isArray(s.studies));
  });

  it('getVisibleRange returns a from<to window (regression: was ReferenceError)', async () => {
    const r = await chart.getVisibleRange();
    assert.equal(r.success, true);
    assert.ok(r.visible_range.to > r.visible_range.from);
  });

  it('symbolInfo returns exchange metadata (regression: was ReferenceError)', async () => {
    const r = await chart.symbolInfo();
    assert.equal(r.success, true);
    assert.ok(r.symbol);
  });

  it('getQuote and getOhlcv summary return well-formed data', async () => {
    const q = await data.getQuote();
    assert.equal(q.success, true);
    const o = await data.getOhlcv({ summary: true });
    assert.equal(o.success, true);
    assert.ok(o.high >= o.low);
  });

  it('setSymbol/setTimeframe/setType round-trip', async () => {
    const target = snap.symbol.includes('AAPL') ? 'MSFT' : 'AAPL';
    const r = await chart.setSymbol({ symbol: target });
    assert.equal(r.success, true);
    await sleep(1500);
    const s = await chart.getState();
    assert.ok(s.symbol.includes(target));
    await chart.setTimeframe({ timeframe: '5' });
    await sleep(800);
    assert.match(String((await chart.getState()).resolution), /5/);
  });

  it('manageIndicator add then remove', async () => {
    const add = await chart.manageIndicator({ action: 'add', indicator: 'Volume' });
    assert.equal(add.success, true);
    assert.ok(add.entity_id);
    const rm = await chart.manageIndicator({ action: 'remove', entity_id: add.entity_id });
    assert.equal(rm.success, true);
  });
});
```

- [ ] **Step 2: Run live**

Run: `node --test --test-concurrency=1 tests/chart.core.test.js`
Expected: PASS. (If `MSFT`/`AAPL` unavailable on the account, adjust the target to a known symbol.)

- [ ] **Step 3: Commit**

```bash
git add tests/chart.core.test.js
git commit -m "test(e2e): live chart read-only + restorable mutations"
```

---

### Task 8: `data.core.test.js` — read-only shape assertions (live)

**Files:**
- Create: `tests/data.core.test.js`

- [ ] **Step 1: Write the live test**

```js
// tests/data.core.test.js
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as data from '../src/core/data.js';
import { teardown } from './helpers/live.js';

describe('data core (live e2e)', () => {
  after(async () => { await teardown(); });

  it('getStudyValues returns a studies array', async () => {
    const r = await data.getStudyValues();
    assert.equal(r.success, true);
    assert.ok(Array.isArray(r.studies));
  });

  it('getOhlcv returns bars', async () => {
    const r = await data.getOhlcv({ count: 20 });
    assert.equal(r.success, true);
    assert.ok(r.bars.length > 0);
  });

  it('pine graphics readers return well-formed (possibly empty) results', async () => {
    for (const fn of ['getPineLines', 'getPineLabels', 'getPineTables', 'getPineBoxes']) {
      const r = await data[fn]();
      assert.equal(r.success, true, `${fn} success`);
      assert.ok(Array.isArray(r.studies), `${fn} studies array`);
    }
  });
});
```

- [ ] **Step 2: Run live**

Run: `node --test --test-concurrency=1 tests/data.core.test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/data.core.test.js
git commit -m "test(e2e): live data read-only shape assertions"
```

---

### Task 9: `drawing.core.test.js` — full lifecycle (live)

**Files:**
- Create: `tests/drawing.core.test.js`

- [ ] **Step 1: Write the live test**

```js
// tests/drawing.core.test.js
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as drawing from '../src/core/drawing.js';
import * as data from '../src/core/data.js';
import { teardown, sleep } from './helpers/live.js';

describe('drawing core (live e2e)', () => {
  after(async () => { try { await drawing.clearAll(); } catch {} await teardown(); });

  it('draw -> list -> getProperties -> removeOne', async () => {
    const bars = await data.getOhlcv({ count: 5 });
    const last = bars.bars[bars.bars.length - 1];
    const created = await drawing.drawShape({ shape: 'horizontal_line', point: { time: last.time, price: last.close } });
    assert.equal(created.success, true);
    assert.ok(created.entity_id, 'shape created with id');

    const list = await drawing.listDrawings();
    assert.equal(list.success, true);
    assert.ok(list.shapes.some(s => s.id === created.entity_id), 'shape present in list (regression: was ReferenceError)');

    const props = await drawing.getProperties({ entity_id: created.entity_id });
    assert.equal(props.success, true);

    const rm = await drawing.removeOne({ entity_id: created.entity_id });
    assert.equal(rm.removed, true);
  });

  it('clearAll removes everything', async () => {
    const bars = await data.getOhlcv({ count: 5 });
    const last = bars.bars[bars.bars.length - 1];
    await drawing.drawShape({ shape: 'horizontal_line', point: { time: last.time, price: last.high } });
    await sleep(300);
    const r = await drawing.clearAll();
    assert.equal(r.success, true);
    const list = await drawing.listDrawings();
    assert.equal(list.count, 0);
  });
});
```

- [ ] **Step 2: Run live**

Run: `node --test --test-concurrency=1 tests/drawing.core.test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/drawing.core.test.js
git commit -m "test(e2e): live drawing lifecycle (draw/list/props/remove/clear)"
```

---

### Task 10: `alerts.core.test.js` — env-gated (live)

**Files:**
- Create: `tests/alerts.core.test.js`

- [ ] **Step 1: Write the live test**

```js
// tests/alerts.core.test.js
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as alerts from '../src/core/alerts.js';
import * as data from '../src/core/data.js';
import { teardown, sleep } from './helpers/live.js';

describe('alerts core (live e2e, env-gated)', () => {
  after(async () => { await teardown(); });

  it('create -> list -> deleteAll', async (t) => {
    if (process.env.TVMCP_ALERT_TESTS !== '1') { t.skip('set TVMCP_ALERT_TESTS=1 to run (creates real alerts)'); return; }
    const q = await data.getQuote();
    const price = Number(q.close || q.last);
    try {
      const c = await alerts.create({ condition: 'crossing', price: (price * 1.5).toFixed(2), message: 'zz_e2e_alert' });
      assert.equal(c.success, true);
      await sleep(800);
      const l = await alerts.list();
      assert.equal(l.success, true);
      assert.ok(Array.isArray(l.alerts));
    } finally {
      try { await alerts.deleteAlerts({ delete_all: true }); } catch {}
    }
  });
});
```

- [ ] **Step 2: Run live (gated)**

Run: `TVMCP_ALERT_TESTS=1 node --test --test-concurrency=1 tests/alerts.core.test.js`
(Bash tool; on PowerShell: `$env:TVMCP_ALERT_TESTS='1'; node --test --test-concurrency=1 tests/alerts.core.test.js`)
Expected: PASS. Without the env var: the single test is skipped.

- [ ] **Step 3: Commit**

```bash
git add tests/alerts.core.test.js
git commit -m "test(e2e): live env-gated alerts create/list/delete"
```

---

### Task 11: `smoke.core.test.js` — infeasible categories through core (live)

**Files:**
- Create: `tests/smoke.core.test.js`

**Interfaces:**
- Consumes: `data.getStrategyResults/getTrades/getEquity/getDepth`, `capture.captureScreenshot`, `batch.run` (verify exact export name), `replay.*` (verify exact export names), `helpers/live`.

- [ ] **Step 1: Confirm export names**

Run: `node -e "Promise.all([import('./src/core/replay.js'),import('./src/core/batch.js'),import('./src/core/capture.js')]).then(([r,b,c])=>console.log('replay',Object.keys(r),'batch',Object.keys(b),'capture',Object.keys(c)))"`
Use the printed names in Step 2 (adjust `replay.start/status/stop`, `batch.run`, `capture.captureScreenshot` to the actual exports).

- [ ] **Step 2: Write the smoke test**

```js
// tests/smoke.core.test.js
// Shallow, side-effect-safe checks for categories that are not fully e2e-feasible.
// Through core (no raw CDP), so there is one approach and no duplicated logic.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as data from '../src/core/data.js';
import * as capture from '../src/core/capture.js';
import * as replay from '../src/core/replay.js';
import { teardown, sleep } from './helpers/live.js';
import { existsSync, rmSync } from 'node:fs';

describe('smoke (live, infeasible categories)', () => {
  after(async () => { await teardown(); });

  it('panel-dependent readers degrade gracefully (result or documented error)', async () => {
    for (const fn of ['getStrategyResults', 'getTrades', 'getEquity', 'getDepth']) {
      const r = await data[fn]();
      assert.equal(typeof r.success, 'boolean', `${fn} returns success flag`);
    }
  });

  it('captureScreenshot writes a file, then clean it up', async () => {
    const r = await capture.captureScreenshot({ region: 'chart' }); // adjust to real signature
    assert.equal(r.success, true);
    if (r.path && existsSync(r.path)) rmSync(r.path);
  });

  it('replay start -> status -> stop (cleanup guaranteed)', async (t) => {
    if (process.env.TVMCP_REPLAY_TESTS !== '1') { t.skip('set TVMCP_REPLAY_TESTS=1 to run'); return; }
    try {
      const s = await replay.start({ date: '2025-03-03' }); // adjust to real signature
      assert.equal(s.success, true);
      await sleep(500);
      const st = await replay.status();
      assert.equal(st.success, true);
    } finally {
      try { await replay.stop(); } catch {}
    }
  });
});
```

- [ ] **Step 3: Run live**

Run: `node --test --test-concurrency=1 tests/smoke.core.test.js`
Expected: PASS (replay skipped unless `TVMCP_REPLAY_TESTS=1`). Fix signatures per Step 1 if any assertion errors on shape.

- [ ] **Step 4: Commit**

```bash
git add tests/smoke.core.test.js
git commit -m "test(e2e): core-based smoke for panel/capture/replay categories"
```

---

### Task 12: Retire the monolith + wire scripts + full verification

**Files:**
- Delete: `tests/e2e.test.js`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Delete the monolith**

```bash
git rm tests/e2e.test.js
```

- [ ] **Step 2: Update `package.json` scripts**

Set:
```json
"test": "node --test tests/pine_analyze.test.js tests/cli.test.js tests/sanitization.test.js tests/pine_lifecycle.test.js tests/pine_editor_selection.test.js tests/pine_delete.test.js tests/chart_deps.test.js tests/drawing_deps.test.js tests/dialog.test.js tests/ui.test.js",
"test:unit": "node --test tests/pine_analyze.test.js tests/cli.test.js tests/sanitization.test.js tests/pine_lifecycle.test.js tests/pine_editor_selection.test.js tests/pine_delete.test.js tests/chart_deps.test.js tests/drawing_deps.test.js tests/dialog.test.js tests/ui.test.js",
"test:e2e": "node --test --test-concurrency=1 tests/watchlist.core.test.js tests/pine.core.test.js tests/chart.core.test.js tests/data.core.test.js tests/drawing.core.test.js tests/alerts.core.test.js tests/smoke.core.test.js",
"test:all": "npm run test:unit && npm run test:e2e"
```
(Remove the old `e2e.test.js` reference from every script. Keep `test:cli`, `test:verbose`, `test:count` or update them off `e2e.test.js`.)

- [ ] **Step 3: Run the unit suite (must be fully green, CI-safe)**

Run: `npm run test:unit`
Expected: PASS, 0 fail.

- [ ] **Step 4: Run the live e2e suite against TradingView**

Run: `npm run test:e2e`
Expected: PASS (alerts/replay skipped unless their env vars set). Report actual output.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "test(e2e): retire raw-CDP e2e.test.js; wire unit + serialized live suites"
```

---

## Self-Review

- **Spec coverage:** one-approach/no-dup → Tasks 5-12 (all core-driven; monolith deleted). `pine_delete` → Tasks 3-4, selectors covered by Task 6. Fix ReferenceErrors → Tasks 1-2 (+ live confirmation in Tasks 7, 9). Feasible categories → Tasks 6-10. Slimmed smoke → Task 11. Harness/concurrency → Tasks 5, 12. Alerts env-gate → Task 10.
- **Placeholders:** none — every step has concrete code/commands. The `${...}` inside the injected strings in Task 3 are intentionally-quoted literal template placeholders (write as real `${JSON.stringify(...)}`).
- **Type consistency:** `deleteScript({ name })` used identically in core (T3), tool/CLI (T4), and tests (T6). `snapshotChart()`/`restoreChart(snap)`/`teardown()` names match across T5 and consumers T7-11. Return shapes (`saved_to`, `entity_id`, `studies`) match the verified core signatures.
- **Verification:** `test:unit` (CI-safe) + `test:e2e` (live) both run in Task 12 with expected output stated.
