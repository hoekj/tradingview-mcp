# Watchlist clear / remove / sort — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `watchlist_remove`, `watchlist_clear`, and `watchlist_sort` to the TradingView MCP server, plus matching CLI subcommands and live e2e tests.

**Architecture:** All three are DOM-driven additions to `src/core/watchlist.js` (no internal TradingView watchlist API exists — confirmed by probing). They reuse two helpers extracted from the existing `add()`: `ensureWatchlistOpen()` (activate the watchlist tab) and `normalizeSymbol()` (match `AAPL` against `NASDAQ:AAPL`). `remove` is the atomic primitive; `clear` loops it; `sort` validates an exact permutation then composes `clear` + `add`.

**Tech Stack:** Node.js (ESM), `chrome-remote-interface` via `src/connection.js` (`evaluate`, `safeString`), `zod` for MCP tool schemas, `node:util parseArgs` for CLI, `node:test` for live e2e.

---

## Reference facts (from live probing — do not re-probe)

- Symbol rows: `[data-symbol-full]` holds the full symbol, e.g. `NYSE:NOK`.
- Per-row remove button: inside the row, an element matched by `[class*="removeButton"]`. `.click()` removes that symbol (works without real hover).
- Row container: `el.closest('[class*="symbol-"]')` or `el.closest('[class*="row"]')`.
- Active list name: `document.querySelector('[data-name="watchlists-button"]').textContent`.
- Watchlist tab activation button: `[data-name="base-watchlist-widget-button"]` or `[aria-label*="Watchlist"]`. The right panel may be showing a different widget (alerts/object-tree), so activation is required before any read/write.

## File structure

- **Modify** `src/core/watchlist.js` — add `ensureWatchlistOpen()`, `normalizeSymbol()`, `getActiveListName()`; refactor `add()` to use `ensureWatchlistOpen()`; enrich `get()` with `active_list`; add `remove()`, `clear()`, `sort()`.
- **Modify** `src/tools/watchlist.js` — register `watchlist_remove`, `watchlist_clear`, `watchlist_sort`.
- **Modify** `src/cli/commands/watchlist.js` — add `remove`, `clear`, `sort` subcommands.
- **Create** `tests/watchlist.core.test.js` — live e2e against the running chart, importing core directly.
- **Modify** `CLAUDE.md`, `README.md` — document the new tools and bump tool counts.

---

## Task 1: Shared helpers + `get()` enrichment

**Files:**
- Modify: `src/core/watchlist.js`
- Test: `tests/watchlist.core.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/watchlist.core.test.js`:

```js
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as watchlist from '../src/core/watchlist.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('watchlist core (live e2e)', () => {
  before(async () => {
    // Ensure the watchlist tab is active before the suite runs.
    await watchlist.get();
    await sleep(300);
  });

  it('get() returns active_list name', async () => {
    const res = await watchlist.get();
    assert.equal(res.success, true, 'get succeeds');
    assert.equal(typeof res.active_list, 'string', 'active_list is a string');
    assert.ok(res.active_list.length > 0, 'active_list is non-empty');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/watchlist.core.test.js`
Expected: FAIL — `active_list is a string` (current `get()` does not return `active_list`).

- [ ] **Step 3: Implement helpers and enrich `get()`**

In `src/core/watchlist.js`, add these helpers above `get()` (after the imports):

```js
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
      var mounted = document.querySelectorAll('[data-symbol-full]').length > 0;
      if (!mounted) { btn.click(); return { opened: true }; }
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
```

Then, in `get()`, replace the `return` block at the end so it also reports the active list name:

```js
  const active_list = await getActiveListName();

  return {
    success: true,
    active_list,
    count: symbols?.symbols?.length || 0,
    source: symbols?.source || 'unknown',
    symbols: symbols?.symbols || [],
  };
```

Also refactor `add()` to reuse the new helper. Replace the inline panel-open block in `add()` (the `const panelState = await evaluate(...)` through the `if (panelState?.opened) await new Promise(...)` lines) with:

```js
  await ensureWatchlistOpen();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/watchlist.core.test.js`
Expected: PASS (2 assertions in the `get()` test).

- [ ] **Step 5: Commit**

```bash
git add src/core/watchlist.js tests/watchlist.core.test.js
git commit -m "feat(watchlist): add ensureWatchlistOpen/normalizeSymbol helpers and active_list in get"
```

---

## Task 2: `remove({ symbol })`

**Files:**
- Modify: `src/core/watchlist.js`
- Test: `tests/watchlist.core.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/watchlist.core.test.js`, inside the `describe` block:

```js
  it('remove() is idempotent for an absent symbol', async () => {
    const res = await watchlist.remove({ symbol: 'ZZZZ_NOT_A_REAL_TICKER' });
    assert.equal(res.success, true, 'absent remove still succeeds');
    assert.equal(res.removed, false, 'nothing was removed');
  });

  it('add() then remove() round-trips a throwaway symbol', async () => {
    const before = await watchlist.get();
    const present = new Set(before.symbols.map(s => watchlist.normalizeSymbol(s.symbol)));
    // Pick a real symbol that is NOT already in the list, so we never clobber the user's.
    const candidates = ['AAPL', 'MSFT', 'KO', 'T', 'F'];
    const testSym = candidates.find(c => !present.has(watchlist.normalizeSymbol(c)));
    assert.ok(testSym, 'found a throwaway symbol not already in the list');

    await watchlist.add({ symbol: testSym });
    await sleep(500);
    const mid = await watchlist.get();
    const midHas = mid.symbols.some(s => watchlist.normalizeSymbol(s.symbol) === watchlist.normalizeSymbol(testSym));
    assert.ok(midHas, `${testSym} present after add`);

    const rem = await watchlist.remove({ symbol: testSym });
    assert.equal(rem.removed, true, `${testSym} removed`);
    await sleep(300);
    const after = await watchlist.get();
    const afterHas = after.symbols.some(s => watchlist.normalizeSymbol(s.symbol) === watchlist.normalizeSymbol(testSym));
    assert.ok(!afterHas, `${testSym} absent after remove`);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/watchlist.core.test.js`
Expected: FAIL — `watchlist.remove is not a function`.

- [ ] **Step 3: Implement `remove()`**

Append to `src/core/watchlist.js`:

```js
export async function remove({ symbol }) {
  await ensureWatchlistOpen();

  const result = await evaluate(`
    (function(symbol) {
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
          var row = els[i].closest('[class*="symbol-"]') || els[i].closest('[class*="row"]') || els[i].parentElement;
          var btn = row ? row.querySelector('[class*="removeButton"]') : null;
          if (!btn) { return { found: true, removed: false, reason: 'remove_button_not_found' }; }
          btn.click();
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
```

Add `safeString` to the import at the top of the file:

```js
import { evaluate, evaluateAsync, getClient, safeString } from '../connection.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/watchlist.core.test.js`
Expected: PASS (idempotent test + round-trip test).

- [ ] **Step 5: Commit**

```bash
git add src/core/watchlist.js tests/watchlist.core.test.js
git commit -m "feat(watchlist): add remove(symbol) with idempotent absent handling"
```

---

## Task 3: `clear({ expect_list })`

**Files:**
- Modify: `src/core/watchlist.js`
- Test: `tests/watchlist.core.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/watchlist.core.test.js`, inside the `describe` block:

```js
  it('clear() refuses when expect_list does not match (non-destructive)', async () => {
    const before = await watchlist.get();
    const wrong = (before.active_list || 'X') + '___WRONG';
    const res = await watchlist.clear({ expect_list: wrong });
    assert.equal(res.success, false, 'clear refuses on mismatch');
    assert.match(res.error, /refusing to clear/i, 'error explains refusal');
    const after = await watchlist.get();
    assert.equal(after.count, before.count, 'list unchanged after refused clear');
  });

  // Destructive: opt-in only. Snapshots and restores the list contents.
  it('clear() empties the active list when name matches', async (t) => {
    if (process.env.WATCHLIST_DESTRUCTIVE_TESTS !== '1') {
      t.skip('set WATCHLIST_DESTRUCTIVE_TESTS=1 to run');
      return;
    }
    const before = await watchlist.get();
    const snapshot = before.symbols.map(s => s.symbol);
    try {
      const res = await watchlist.clear({ expect_list: before.active_list });
      assert.equal(res.success, true, 'clear succeeds with correct name');
      await sleep(300);
      const after = await watchlist.get();
      assert.equal(after.count, 0, 'list is empty after clear');
    } finally {
      for (const sym of snapshot) {
        await watchlist.add({ symbol: sym });
        await sleep(400);
      }
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/watchlist.core.test.js`
Expected: FAIL — `watchlist.clear is not a function`. (The destructive test is skipped by default.)

- [ ] **Step 3: Implement `clear()`**

Append to `src/core/watchlist.js`:

```js
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
  let removed = 0;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await evaluate(`
      (function() {
        var el = document.querySelector('[data-symbol-full]');
        if (!el) { return { removed: false }; }
        var row = el.closest('[class*="symbol-"]') || el.closest('[class*="row"]') || el.parentElement;
        var btn = row ? row.querySelector('[class*="removeButton"]') : null;
        if (!btn) { return { removed: false, reason: 'remove_button_not_found' }; }
        btn.click();
        return { removed: true };
      })()
    `);
    if (!res?.removed) {
      break;
    }
    removed++;
    await new Promise(r => setTimeout(r, 150));
  }

  return { success: true, cleared: true, removed_count: removed, list: activeList };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/watchlist.core.test.js`
Expected: PASS — refusal test passes; destructive test is skipped (printed as skipped).

- [ ] **Step 5: Commit**

```bash
git add src/core/watchlist.js tests/watchlist.core.test.js
git commit -m "feat(watchlist): add clear(expect_list) with name guard"
```

---

## Task 4: `sort({ symbols })`

**Files:**
- Modify: `src/core/watchlist.js`
- Test: `tests/watchlist.core.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/watchlist.core.test.js`, inside the `describe` block:

```js
  it('sort() rejects a non-permutation (extra symbol, non-destructive)', async () => {
    const before = await watchlist.get();
    const input = before.symbols.map(s => s.symbol).concat('ZZZZ_FAKE');
    const res = await watchlist.sort({ symbols: input });
    assert.equal(res.success, false, 'sort refuses non-permutation');
    assert.ok(res.extra && res.extra.length > 0, 'reports extra symbols');
    const after = await watchlist.get();
    assert.equal(after.count, before.count, 'list unchanged after refused sort');
  });

  it('sort() reorders an exact permutation and restores order', async () => {
    const before = await watchlist.get();
    const original = before.symbols.map(s => s.symbol);
    if (original.length < 2) {
      return; // need at least two symbols to observe a reorder
    }
    const reversed = [...original].reverse();
    try {
      const res = await watchlist.sort({ symbols: reversed });
      assert.equal(res.success, true, 'sort succeeds for a permutation');
      await sleep(300);
      const after = await watchlist.get();
      const got = after.symbols.map(s => watchlist.normalizeSymbol(s.symbol));
      const want = reversed.map(s => watchlist.normalizeSymbol(s));
      assert.deepEqual(got, want, 'order matches the requested permutation');
    } finally {
      await watchlist.sort({ symbols: original });
      await sleep(300);
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/watchlist.core.test.js`
Expected: FAIL — `watchlist.sort is not a function`.

- [ ] **Step 3: Implement `sort()`**

Append to `src/core/watchlist.js`:

```js
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
  await clear({});
  await new Promise(r => setTimeout(r, 300));
  for (const sym of symbols) {
    await add({ symbol: sym });
    await new Promise(r => setTimeout(r, 400));
  }

  const final = await get();
  return { success: true, sorted: true, order: final.symbols.map(s => s.symbol) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/watchlist.core.test.js`
Expected: PASS — rejection test and reorder/restore test both pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/watchlist.js tests/watchlist.core.test.js
git commit -m "feat(watchlist): add sort(symbols) via exact-permutation clear+re-add"
```

---

## Task 5: Register MCP tools

**Files:**
- Modify: `src/tools/watchlist.js`

- [ ] **Step 1: Add the three tool registrations**

In `src/tools/watchlist.js`, add a reusable Escape-recovery helper and the three tools inside `registerWatchlistTools(server)`, after the existing `watchlist_add` registration:

```js
  async function escapeRecover() {
    try {
      const { getClient } = await import('../connection.js');
      const c = await getClient();
      await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    } catch (_) {}
  }

  server.tool('watchlist_remove', 'Remove a single symbol from the active TradingView watchlist (idempotent if absent)', {
    symbol: z.string().describe('Symbol to remove (e.g., AAPL, NYSE:NOK)'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.remove({ symbol })); }
    catch (err) { await escapeRecover(); return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_clear', 'Remove all symbols from the active watchlist. If expect_list is given, refuses unless the active list name matches.', {
    expect_list: z.string().optional().describe('Guard: only clear if the active list has this exact name'),
  }, async ({ expect_list }) => {
    try { return jsonResult(await core.clear({ expect_list })); }
    catch (err) { await escapeRecover(); return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_sort', 'Reorder the active watchlist to match the given symbol array. The array must be an exact permutation of the current symbols.', {
    symbols: z.array(z.string()).describe('Desired order — must contain exactly the symbols currently in the list'),
  }, async ({ symbols }) => {
    try { return jsonResult(await core.sort({ symbols })); }
    catch (err) { await escapeRecover(); return jsonResult({ success: false, error: err.message }, true); }
  });
```

- [ ] **Step 2: Verify the server starts and registers the tools**

Run: `node -e "import('./src/server.js').then(() => console.log('ok')).catch(e => { console.error(e); process.exit(1); })"`
Expected: prints `ok` (or the server's normal stdio startup) with no import/registration error.

> If `src/server.js` blocks on stdio transport and does not exit, instead run a registration smoke check:
> Run: `node -e "import('./src/tools/watchlist.js').then(m => { const tools=[]; m.registerWatchlistTools({ tool:(n)=>tools.push(n) }); console.log(tools.join(',')); })"`
> Expected: `watchlist_get,watchlist_add,watchlist_remove,watchlist_clear,watchlist_sort`

- [ ] **Step 3: Commit**

```bash
git add src/tools/watchlist.js
git commit -m "feat(watchlist): register remove/clear/sort MCP tools"
```

---

## Task 6: CLI subcommands

**Files:**
- Modify: `src/cli/commands/watchlist.js`

- [ ] **Step 1: Add the three subcommands**

Replace the `subcommands: new Map([...])` contents in `src/cli/commands/watchlist.js` so it includes the new entries (keep `get` and `add` as-is):

```js
register('watchlist', {
  description: 'Watchlist tools (get, add, remove, clear, sort)',
  subcommands: new Map([
    ['get', {
      description: 'Get watchlist symbols',
      handler: () => core.get(),
    }],
    ['add', {
      description: 'Add a symbol to the watchlist',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Symbol required. Usage: tv watchlist add AAPL');
        return core.add({ symbol: positionals[0] });
      },
    }],
    ['remove', {
      description: 'Remove a symbol from the active watchlist',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Symbol required. Usage: tv watchlist remove AAPL');
        return core.remove({ symbol: positionals[0] });
      },
    }],
    ['clear', {
      description: 'Remove all symbols from the active watchlist',
      options: { expect: { type: 'string', description: 'Only clear if the active list has this name' } },
      handler: (opts) => core.clear({ expect_list: opts.expect }),
    }],
    ['sort', {
      description: 'Reorder the active watchlist (exact permutation of current symbols)',
      handler: (opts, positionals) => {
        if (positionals.length === 0) throw new Error('Symbols required. Usage: tv watchlist sort AAPL MSFT KO');
        return core.sort({ symbols: positionals });
      },
    }],
  ]),
});
```

- [ ] **Step 2: Verify CLI parsing (help output)**

Run: `node src/cli/index.js watchlist --help`
Expected: lists subcommands `get, add, remove, clear, sort`.

- [ ] **Step 3: Verify a non-destructive command runs end-to-end**

Run: `node src/cli/index.js watchlist clear --expect __definitely_not_a_real_list__`
Expected: JSON with `"success": false` and an error containing `refusing to clear` (guard refuses; nothing is removed).

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/watchlist.js
git commit -m "feat(watchlist): add remove/clear/sort CLI subcommands"
```

---

## Task 7: Documentation + tool counts

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Update CLAUDE.md**

In `CLAUDE.md`, change the opening line `68 tools for reading and controlling...` to `71 tools for reading and controlling...`.

In the `### "Navigate the UI"` / watchlist area, replace the watchlist bullets (the lines describing `watchlist_get` / `watchlist_add`, under a "Manage your watchlist" heading — add the heading if absent) with:

```markdown
### "Manage your watchlist"
- `watchlist_get` → read active list symbols (returns `active_list` name + rows)
- `watchlist_add` → add a symbol
- `watchlist_remove` → remove one symbol (idempotent if absent)
- `watchlist_clear` → remove all symbols; pass `expect_list` to guard against clearing the wrong list
- `watchlist_sort` → reorder to match an exact permutation of the current symbols
```

- [ ] **Step 2: Update README.md**

In `README.md`, find the watchlist tool listing/count and add `watchlist_remove`, `watchlist_clear`, `watchlist_sort`. Update any total tool count that mentions the old number (search for `68` and the watchlist section) to reflect three new tools.

Run to find the spots: `git grep -n -e "watchlist_add" -e "watchlist_get" -- README.md`
Apply edits so all three new tools appear alongside the existing two, and bump any tool-count total by 3.

- [ ] **Step 3: Verify counts are consistent**

Run: `git grep -n -e "watchlist_remove" -e "watchlist_clear" -e "watchlist_sort" -- README.md CLAUDE.md`
Expected: each tool appears in both files.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs(watchlist): document remove/clear/sort and bump tool counts"
```

---

## Final verification

- [ ] **Run the full new test file:**

Run: `node --test tests/watchlist.core.test.js`
Expected: all tests pass; the destructive `clear()` empties-the-list test shows as skipped (unless `WATCHLIST_DESTRUCTIVE_TESTS=1`).

- [ ] **Optionally run the destructive clear test once, manually:**

Run: `$env:WATCHLIST_DESTRUCTIVE_TESTS=1; node --test tests/watchlist.core.test.js` (PowerShell)
Expected: passes; the active list is emptied then restored to its original membership.

---

## Self-review notes (already applied)

- **Spec coverage:** remove (Task 2), clear + expect_list guard (Task 3), sort exact-permutation via clear+re-add (Task 4), `active_list` enrichment + helpers (Task 1), MCP tools (Task 5), CLI (Task 6), docs (Task 7). All spec sections are covered.
- **Type consistency:** return shapes are stable — `remove` → `{ success, removed, symbol, ... }`; `clear` → `{ success, cleared, removed_count, list }` or `{ success:false, error }`; `sort` → `{ success, sorted, order }` or `{ success:false, error, missing, extra, duplicates }`. Helper names `ensureWatchlistOpen`, `normalizeSymbol`, `getActiveListName` are used identically across tasks.
- **Non-destructive by default:** every automated test either operates on a throwaway symbol, asserts a refusal, or snapshots-and-restores. The only list-emptying test is opt-in via `WATCHLIST_DESTRUCTIVE_TESTS=1`.
- **Known limitation:** `sort` loses section dividers (clear+re-add). Documented in the spec.
```
