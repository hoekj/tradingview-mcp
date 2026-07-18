# screener_get_rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one MCP tool, `screener_get_rows`, that makes a named saved screen the active TradingView screener and returns its rows as `EXCH:TICKER[]`, restoring the screener panel to the state it found it in.

**Architecture:** A new DOM-driven domain module `src/core/screener.js`, modelled on `src/core/watchlist.js`. Pure decision logic (name matching, completeness derivation) is separated from DOM access so it can be unit-tested without a browser, using the `_deps` injection pattern already used by `layoutSwitch` in `src/core/ui.js`. A thin `src/tools/screener.js` registers the tool.

**Tech Stack:** Node ESM, `@modelcontextprotocol/sdk`, `zod` (v4), `chrome-remote-interface` via the shared helpers in `src/connection.js`, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-07-18-screener-get-rows-design.md`

## Global Constraints

- Package manager is **pnpm** — use `pnpm` / `pnpx`, never `npm` / `npx`.
- All imports at the top of the file. `tests/screener_deps.test.js` grows across Tasks 1–4; each task shows the symbols it needs as a fresh `import` line for readability, but **merge them into the single existing top-of-file import from `../src/core/screener.js`** rather than appending a second import statement.
- Defensive programming: always use braces for single-line `if` statements.
- Comments in English only.
- In-page JavaScript (anything inside an `evaluate()` template string) must be **ES5-style IIFEs** returning plain objects. It runs in the page via CDP and cannot reach Node functions or use modern syntax helpers relied on elsewhere.
- Interpolate caller values into page JS with `safeString()` from `src/connection.js` — never `JSON.stringify` and never raw concatenation.
- Anchor on stable `data-name` attributes and literal visible text. **Never** anchor on a hashed CSS class (`title-IMAw04Wp`, `screenerContainer-YDNuDm2h`) as an exact value — match with `[class*="..."]` prefixes only, treating the class as a hint.
- The core module **returns** `{ success: false, error, ... }` for expected failures; it does not throw. Internal helpers may throw, and `get()` converts those to the returned shape.
- Never return a bare ticker. `data-rowkey` values (`NYSE:NOK`) are returned verbatim.
- `total` is always `null`. TradingView exposes no result count; `null` means "not observable" and must never be inferred or defaulted to `0`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/screener.js` (create) | All screener logic: pure matching/derivation helpers + DOM-driven flow + `get()` orchestration |
| `src/tools/screener.js` (create) | MCP tool registration for `screener_get_rows` |
| `src/core/index.js` (modify) | Export the new core module |
| `src/server.js` (modify) | Import and call `registerScreenerTools` |
| `tests/screener_deps.test.js` (create) | Unit tests — pure helpers + dep-injected flow, no browser |
| `tests/screener.core.test.js` (create) | Live e2e tests against TV Desktop |
| `package.json` (modify) | Add both test files to the right scripts |
| `CLAUDE.md` (modify) | Document the tool in the decision tree |

---

### Task 1: Branch and pure helpers

The two decisions that must never be wrong — which screen row was matched, and whether the row set is complete — are pure functions over plain data. Building them first means they are fully tested before any DOM code exists.

**Files:**
- Create: `src/core/screener.js`
- Create: `tests/screener_deps.test.js`
- Modify: `package.json:18` (add `tests/screener_deps.test.js` to `test:unit`)
- Modify: `package.json:17` (add the same file to `test`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pickScreenMatch(rows, name)` where `rows` is `Array<{name: string, section: string}>` and `name` is a string. Returns `{status: 'ok', match: {name, section}}` | `{status: 'not_found', available: rows}` | `{status: 'ambiguous', matches: Array<{name, section}>}`.
  - `deriveComplete({scrollHeight, clientHeight})` returns `boolean`.

- [ ] **Step 1: Create the branch**

```bash
git checkout main && git pull
git checkout -b feature/screener-get-rows
```

- [ ] **Step 2: Write the failing tests**

Create `tests/screener_deps.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickScreenMatch, deriveComplete } from '../src/core/screener.js';

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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec node --test tests/screener_deps.test.js`
Expected: FAIL — `Cannot find module '.../src/core/screener.js'`

- [ ] **Step 4: Write the minimal implementation**

Create `src/core/screener.js`:

```js
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec node --test tests/screener_deps.test.js`
Expected: PASS — 9 tests passing

- [ ] **Step 6: Register the unit test file**

In `package.json`, append ` tests/screener_deps.test.js` to the end of **both** the `test` script (line 17) and the `test:unit` script (line 18), immediately after `tests/ui.test.js`.

- [ ] **Step 7: Verify the suite still passes**

Run: `pnpm run test:unit`
Expected: PASS — all pre-existing tests plus the 9 new ones

- [ ] **Step 8: Commit**

```bash
git add src/core/screener.js tests/screener_deps.test.js package.json
git commit -m "feat(screener): exact screen matching and completeness derivation"
```

---

### Task 2: Panel open/close with state tracking

`ensureScreenerOpen` must report whether *it* opened the panel, because that flag decides whether the panel gets closed again at the end. Closing is its own problem: the screener panel has no close button of its own — the affordance lives in the surrounding chrome and its `aria-label="Close"` is not unique page-wide.

**Files:**
- Modify: `src/core/screener.js`
- Modify: `tests/screener_deps.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime.
- Produces:
  - `resolveDeps(_deps)` returns `{evaluate, click, keyboard, sleep}`.
  - `waitFor(fn, deps, {maxMs, interval})` returns `Promise<boolean>`.
  - `getActiveScreenName(_deps)` returns `Promise<string|null>`.
  - `ensureScreenerOpen(_deps)` returns `Promise<{opened: boolean}>`; throws on timeout.
  - `closeScreenerPanel(_deps)` returns `Promise<true>`; throws if the panel will not close.

- [ ] **Step 1: Write the failing tests**

Append to `tests/screener_deps.test.js`:

```js
import { ensureScreenerOpen, closeScreenerPanel, getActiveScreenName } from '../src/core/screener.js';

// Build injected deps modelling the live screener panel. `state.open` is what
// the page reports; click() flips it the way the real button does.
function makePanelDeps({ open = false, closable = true } = {}) {
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
        state.open = false;
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec node --test tests/screener_deps.test.js`
Expected: FAIL — `ensureScreenerOpen is not a function` (or an import error)

- [ ] **Step 3: Write the implementation**

Add to the top of `src/core/screener.js`, above the existing helpers:

```js
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
```

Then append these functions to `src/core/screener.js`:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec node --test tests/screener_deps.test.js`
Expected: PASS — 9 tests from Task 1 plus 8 new ones

- [ ] **Step 5: Verify the close button responds to a JS click on the live app**

The close button is a real `<button>` in the panel chrome, unlike the custom menu items that ignore synthetic clicks — but this is the one step of the flow that was verified with a CDP click rather than an in-page `.click()`. Confirm it before building on it.

With TradingView Desktop running and the screener panel **open**:

```bash
pnpm exec node -e "import('./src/core/screener.js').then(async (s) => { console.log(await s.closeScreenerPanel()); const { disconnect } = await import('./src/connection.js'); await disconnect(); })"
```

Expected: prints `true`, and the screener panel visibly disappears.

**If it prints an error instead**, the in-page `.click()` no-opped. Replace the click with a real CDP mouse click at the button's centre — return the button's `getBoundingClientRect()` from the `evaluate` instead of clicking, then dispatch through `mouseClick` from `./ui.js`. Record which path was needed in a comment.

- [ ] **Step 6: Commit**

```bash
git add src/core/screener.js tests/screener_deps.test.js
git commit -m "feat(screener): open panel with state tracking, close by proximity-scoped button"
```

---

### Task 3: Open the screen dialog and read its rows

The Open-screen dialog is the only authoritative list of screens. The title menu's inline list is deliberately not used: probing found five entries where the account has six saved screens, so matching against it would report `not_found` for screens that exist.

**Files:**
- Modify: `src/core/screener.js`
- Modify: `tests/screener_deps.test.js`

**Interfaces:**
- Consumes: `resolveDeps`, `waitFor` from Task 2.
- Produces:
  - `openScreenDialog(_deps)` returns `Promise<true>`; throws if the dialog does not open.
  - `readDialogRows(_deps)` returns `Promise<Array<{name: string, section: string}>>`; throws if the dialog is gone.
  - `searchDialog(name, _deps)` returns `Promise<true>`; throws if the search input is missing.

- [ ] **Step 1: Write the failing tests**

Append to `tests/screener_deps.test.js`:

```js
import { openScreenDialog, readDialogRows, searchDialog } from '../src/core/screener.js';

const DIALOG_ROWS = [
  { name: 'Pre-market most active', section: 'MY SCREENS' },
  { name: 'Most active', section: 'MY SCREENS' },
  { name: 'All stocks', section: 'POPULAR SCREENS' },
];

function makeDialogDeps({ menuOpens = true, dialogOpens = true, rows = DIALOG_ROWS, hasInput = true } = {}) {
  const state = { dialogOpen: false, keys: [], typed: null, clicks: [] };
  const deps = {
    evaluate: async (expr) => {
      const src = String(expr);
      if (src.includes("'Open screen…'")) {
        return menuOpens ? { ok: true } : { ok: false, reason: 'menu not open' };
      }
      if (src.includes('screener-custom-screens-dialog') && src.includes('!!')) {
        return state.dialogOpen;
      }
      if (src.includes("placeholder === 'Search'") || src.includes('placeholder=="Search"')) {
        return hasInput ? { ok: true } : { ok: false };
      }
      if (src.includes('MY SCREENS')) {
        if (!state.dialogOpen) { return { ok: false, reason: 'dialog_gone' }; }
        return { ok: true, rows };
      }
      return null;
    },
    click: async ({ by, value }) => { state.clicks.push(`${by}:${value}`); return { success: true }; },
    keyboard: async ({ key }) => {
      state.keys.push(key);
      if (key === 'Enter' && state.keys.length === 1 && dialogOpens) { state.dialogOpen = true; }
      return { success: true };
    },
    typeText: async ({ text }) => { state.typed = text; return { success: true }; },
    sleep: async () => {},
  };
  return { deps, state };
}

describe('openScreenDialog()', () => {
  it('clicks the title, focuses the menu item and presses Enter', async () => {
    const { deps, state } = makeDialogDeps({});
    const res = await openScreenDialog(deps);
    assert.equal(res, true);
    assert.deepEqual(state.clicks, ['data-name:screener-topbar-screen-title']);
    assert.deepEqual(state.keys, ['Enter'], 'activated with a real Enter key');
  });

  it('throws when the title menu does not open', async () => {
    const { deps } = makeDialogDeps({ menuOpens: false });
    await assert.rejects(() => openScreenDialog(deps), /did not open/i);
  });

  it('throws when Enter does not produce the dialog', async () => {
    const { deps } = makeDialogDeps({ dialogOpens: false });
    await assert.rejects(() => openScreenDialog(deps), /did not open/i);
  });
});

describe('readDialogRows()', () => {
  it('returns rows tagged with their section', async () => {
    const { deps, state } = makeDialogDeps({});
    state.dialogOpen = true;
    const rows = await readDialogRows(deps);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { name: 'Pre-market most active', section: 'MY SCREENS' });
    assert.equal(rows[2].section, 'POPULAR SCREENS');
  });

  it('throws when the dialog has closed underneath it', async () => {
    const { deps } = makeDialogDeps({});
    await assert.rejects(() => readDialogRows(deps), /dialog/i);
  });
});

describe('searchDialog()', () => {
  it('focuses the search input and types the literal name', async () => {
    const { deps, state } = makeDialogDeps({});
    const res = await searchDialog('Cam Prefilter', deps);
    assert.equal(res, true);
    assert.equal(state.typed, 'Cam Prefilter');
  });

  it('throws when the search input is missing', async () => {
    const { deps } = makeDialogDeps({ hasInput: false });
    await assert.rejects(() => searchDialog('X', deps), /search/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec node --test tests/screener_deps.test.js`
Expected: FAIL — `openScreenDialog is not a function`

- [ ] **Step 3: Add `typeText` to the resolved deps**

In `src/core/screener.js`, extend the import and `resolveDeps`:

```js
import { click as clickImpl, keyboard as keyboardImpl, typeText as typeTextImpl } from './ui.js';
```

and inside `resolveDeps`, add the line:

```js
    typeText: _deps?.typeText || typeTextImpl,
```

- [ ] **Step 4: Write the implementation**

Append to `src/core/screener.js`:

```js
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec node --test tests/screener_deps.test.js`
Expected: PASS — 17 tests from Tasks 1–2 plus 7 new ones

- [ ] **Step 6: Commit**

```bash
git add src/core/screener.js tests/screener_deps.test.js
git commit -m "feat(screener): open the screen dialog and read both sections"
```

---

### Task 4: Scrape rows and orchestrate `get()`

This assembles the flow: open → short-circuit → dialog → search → guard → select → verify → scrape → restore.

**Files:**
- Modify: `src/core/screener.js`
- Modify: `tests/screener_deps.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces:
  - `scrapeRows(_deps)` returns `Promise<{rows: string[], scrollHeight: number|null, clientHeight: number|null}>`.
  - `get({screenName, _deps})` returns the tool's result object.

- [ ] **Step 1: Write the failing tests**

Append to `tests/screener_deps.test.js`:

```js
import { get, scrapeRows } from '../src/core/screener.js';

const KEYS = ['NYSE:NOK', 'NASDAQ:SOFI', 'AMEX:PSLV'];

// A full fake of the screener surface: panel, title menu, dialog, results table.
function makeFullDeps({
  startOpen = false,
  active = 'Cam Prefilter',
  rows = DIALOG_ROWS,
  keys = KEYS,
  overflow = false,
  selectLands = true,
} = {}) {
  const state = {
    open: startOpen, active, dialogOpen: false,
    keys: [], typed: null, clicks: [], closed: false, escapes: 0,
  };
  const deps = {
    evaluate: async (expr) => {
      const src = String(expr);
      if (src.includes('screener-topbar-screen-title') && src.includes('!!')) { return state.open; }
      if (src.includes('screener-topbar-screen-title') && src.includes('innerText')) {
        return state.open ? state.active : null;
      }
      if (src.includes("'Open screen…'")) { return { ok: true }; }
      if (src.includes('screener-custom-screens-dialog') && src.includes('!!')) { return state.dialogOpen; }
      if (src.includes("placeholder === 'Search'")) { return { ok: true }; }
      if (src.includes('MY SCREENS')) {
        if (!state.dialogOpen) { return { ok: false, reason: 'dialog_gone' }; }
        const q = (state.typed || '').trim().toLowerCase();
        return { ok: true, rows: q ? rows.filter(r => r.name.toLowerCase().includes(q)) : rows };
      }
      if (src.includes('selectable-rows-table-body')) {
        return {
          ok: true, rows: keys,
          scrollHeight: overflow ? 900 : 378,
          clientHeight: 378,
        };
      }
      if (src.includes('screenerContainer') && src.trim().startsWith('!')) { return !state.open; }
      if (src.includes('aria-label="Close"')) {
        if (!state.open) { return { ok: true, note: 'already closed' }; }
        state.open = false; state.closed = true;
        return { ok: true, clicked: true };
      }
      return null;
    },
    click: async ({ by, value }) => {
      state.clicks.push(`${by}:${value}`);
      if (value === 'screener-dialog-button') { state.open = true; }
      return { success: true };
    },
    keyboard: async ({ key }) => {
      state.keys.push(key);
      if (key === 'Enter' && !state.dialogOpen) { state.dialogOpen = true; return { success: true }; }
      if (key === 'Enter' && state.dialogOpen && state.keys.includes('ArrowDown')) {
        state.dialogOpen = false;
        if (selectLands) { state.active = (state.typed || '').trim(); }
      }
      if (key === 'Escape') { state.escapes++; state.dialogOpen = false; }
      return { success: true };
    },
    typeText: async ({ text }) => { state.typed = text; return { success: true }; },
    sleep: async () => {},
  };
  return { deps, state };
}

describe('scrapeRows()', () => {
  it('returns rowkeys verbatim with the scroller measurements', async () => {
    const { deps } = makeFullDeps({ startOpen: true });
    const res = await scrapeRows(deps);
    assert.deepEqual(res.rows, KEYS, 'exchange-qualified symbols preserved');
    assert.equal(res.clientHeight, 378);
  });
});

describe('get()', () => {
  it('selects the requested screen and returns its rows', async () => {
    const { deps, state } = makeFullDeps({ active: 'Cam Prefilter' });
    const res = await get({ screenName: 'Pre-market most active', _deps: deps });
    assert.equal(res.success, true, 'succeeds');
    assert.equal(res.screen, 'Pre-market most active', 'reports the active screen');
    assert.deepEqual(res.rows, KEYS);
    assert.equal(res.count, 3);
    assert.equal(res.complete, true);
    assert.equal(res.total, null, 'total is never inferred');
    assert.deepEqual(state.keys.filter(k => k === 'ArrowDown'), ['ArrowDown'], 'highlight moved into the list before Enter');
  });

  it('short-circuits when the screen is already active', async () => {
    const { deps, state } = makeFullDeps({ active: 'Pre-market most active' });
    const res = await get({ screenName: 'pre-market MOST active', _deps: deps });
    assert.equal(res.success, true);
    assert.equal(res.note, 'already active');
    assert.deepEqual(state.clicks.filter(c => c.includes('screen-title')), [], 'the title menu was never opened');
  });

  it('scrapes the active screen when screenName is omitted', async () => {
    const { deps, state } = makeFullDeps({ active: 'Cam Prefilter' });
    const res = await get({ _deps: deps });
    assert.equal(res.success, true);
    assert.equal(res.screen, 'Cam Prefilter');
    assert.equal(state.typed, null, 'no search was performed');
  });

  it('returns not_found with the available list', async () => {
    const { deps } = makeFullDeps({ active: 'Cam Prefilter' });
    const res = await get({ screenName: '__no_such_screen__', _deps: deps });
    assert.equal(res.success, false);
    assert.match(res.error, /not found/i);
    assert.ok(Array.isArray(res.available), 'available is a list');
  });

  it('refuses an ambiguous name rather than guessing', async () => {
    const ambiguous = [
      { name: 'Most active', section: 'MY SCREENS' },
      { name: 'Most active', section: 'POPULAR SCREENS' },
    ];
    const { deps } = makeFullDeps({ active: 'Cam Prefilter', rows: ambiguous });
    const res = await get({ screenName: 'Most active', _deps: deps });
    assert.equal(res.success, false);
    assert.match(res.error, /ambiguous/i);
    assert.equal(res.matches.length, 2);
  });

  it('rejects a blank screenName', async () => {
    const { deps } = makeFullDeps({});
    const res = await get({ screenName: '   ', _deps: deps });
    assert.equal(res.success, false);
    assert.match(res.error, /required/i);
  });

  it('fails loudly when the title does not change after selecting', async () => {
    const { deps } = makeFullDeps({ active: 'Cam Prefilter', selectLands: false });
    const res = await get({ screenName: 'Pre-market most active', _deps: deps });
    assert.equal(res.success, false);
    assert.match(res.error, /but the active screen is/i);
  });

  it('reports incomplete when the results overflow', async () => {
    const { deps } = makeFullDeps({ active: 'Pre-market most active', overflow: true });
    const res = await get({ screenName: 'Pre-market most active', _deps: deps });
    assert.equal(res.complete, false);
    assert.equal(res.count, 3, 'still reports what it did get');
  });

  it('closes the panel it opened', async () => {
    const { deps, state } = makeFullDeps({ startOpen: false, active: 'Pre-market most active' });
    await get({ screenName: 'Pre-market most active', _deps: deps });
    assert.equal(state.closed, true, 'panel closed again');
  });

  it('leaves a panel it did not open alone', async () => {
    const { deps, state } = makeFullDeps({ startOpen: true, active: 'Pre-market most active' });
    await get({ screenName: 'Pre-market most active', _deps: deps });
    assert.equal(state.closed, false, 'user panel untouched');
    assert.equal(state.open, true);
  });

  it('restores panel state even when the call fails', async () => {
    const { deps, state } = makeFullDeps({ startOpen: false, active: 'Cam Prefilter' });
    const res = await get({ screenName: '__no_such_screen__', _deps: deps });
    assert.equal(res.success, false);
    assert.equal(state.closed, true, 'panel closed despite the failure');
    assert.ok(state.escapes > 0, 'the dialog was dismissed');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec node --test tests/screener_deps.test.js`
Expected: FAIL — `get is not a function`

- [ ] **Step 3: Write the implementation**

Append to `src/core/screener.js`:

```js
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
      await searchDialog(target, d);

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
    const scraped = await scrapeRows(d);
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec node --test tests/screener_deps.test.js`
Expected: PASS — 24 tests from Tasks 1–3 plus 12 new ones

- [ ] **Step 5: Commit**

```bash
git add src/core/screener.js tests/screener_deps.test.js
git commit -m "feat(screener): scrape rows and orchestrate get() with panel restore"
```

---

### Task 5: Register the MCP tool and wire it up

**Files:**
- Create: `src/tools/screener.js`
- Modify: `src/core/index.js:16` (add the export)
- Modify: `src/server.js:16` (add the import) and `src/server.js:86` (add the call)

**Interfaces:**
- Consumes: `get({screenName})` from `src/core/screener.js`.
- Produces: the MCP tool `screener_get_rows`, and `registerScreenerTools(server)`.

- [ ] **Step 1: Create the tool module**

Create `src/tools/screener.js`:

```js
import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/screener.js';

export function registerScreenerTools(server) {
  // Dismiss any overlay left open by an unexpected error.
  async function escapeRecover() {
    try {
      const { getClient } = await import('../connection.js');
      const c = await getClient();
      await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    } catch (_) {}
  }

  server.tool('screener_get_rows',
    'Make the named saved screen the active screener and return its rows as EXCH:TICKER[]. Omit screenName to scrape the currently active screen. Fails loudly if the screen is missing or the name is ambiguous.',
    {
      screenName: z.string().optional().describe('Exact saved screen name, e.g. "Pre-market most active". Omit to use the active screen.'),
    },
    async ({ screenName }) => {
      try { return jsonResult(await core.get({ screenName })); }
      catch (err) { await escapeRecover(); return jsonResult({ success: false, error: err.message }, true); }
    });
}
```

- [ ] **Step 2: Export the core module**

In `src/core/index.js`, add after line 16 (`export * as ui from './ui.js';`):

```js
export * as screener from './screener.js';
```

- [ ] **Step 3: Wire the tool into the server**

In `src/server.js`, add after line 16 (`import { registerTabTools } from './tools/tab.js';`):

```js
import { registerScreenerTools } from './tools/screener.js';
```

and after line 86 (`registerTabTools(server);`):

```js
registerScreenerTools(server);
```

- [ ] **Step 4: Verify the server starts and exposes the tool**

Run: `pnpm exec node -e "import('./src/tools/screener.js').then(m => { const names = []; m.registerScreenerTools({ tool: (n) => names.push(n) }); console.log(names); })"`
Expected: prints `[ 'screener_get_rows' ]`

- [ ] **Step 5: Verify the whole unit suite still passes**

Run: `pnpm run test:unit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/screener.js src/core/index.js src/server.js
git commit -m "feat(screener): register the screener_get_rows MCP tool"
```

---

### Task 6: Live end-to-end test

**Files:**
- Create: `tests/screener.core.test.js`
- Modify: `package.json:19` (add the file to `test:e2e`)

**Interfaces:**
- Consumes: `get`, `ensureScreenerOpen`, `closeScreenerPanel`, `getActiveScreenName` from `src/core/screener.js`.
- Produces: nothing consumed by later tasks.

**Prerequisites:** TradingView Desktop running with CDP on port 9222, and `Pre-market most active` saved in MY SCREENS.

- [ ] **Step 1: Write the live test**

Create `tests/screener.core.test.js`:

```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as screener from '../src/core/screener.js';
import { disconnect } from '../src/connection.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SCREEN = 'Pre-market most active';

describe('screener core (live e2e)', () => {
  let startingScreen = null;
  let startedOpen = false;

  before(async () => {
    // Snapshot the user's screener state so the suite can restore it.
    const opened = await screener.ensureScreenerOpen();
    startedOpen = !opened.opened;
    startingScreen = await screener.getActiveScreenName();
    if (!startedOpen) {
      await screener.closeScreenerPanel();
    }
    await sleep(300);
  });

  after(async () => {
    // Restore the original screen and panel state, then close the shared CDP
    // websocket so `node --test` can exit instead of hanging.
    try {
      if (startingScreen) {
        await screener.get({ screenName: startingScreen });
      }
      if (startedOpen) {
        await screener.ensureScreenerOpen();
      }
    } catch (_) {}
    await disconnect();
  });

  it('returns rows for a named screen', async () => {
    const res = await screener.get({ screenName: SCREEN });
    assert.equal(res.success, true, 'get succeeds');
    assert.equal(res.screen, SCREEN, 'the requested screen is active');
    assert.ok(Array.isArray(res.rows), 'rows is an array');
    assert.ok(res.rows.length > 0, 'rows is non-empty');
    assert.equal(res.count, res.rows.length, 'count matches rows');
    assert.equal(typeof res.complete, 'boolean', 'complete is a boolean');
    assert.equal(res.total, null, 'total is null — TradingView exposes no count');
  });

  it('returns exchange-qualified symbols', async () => {
    const res = await screener.get({ screenName: SCREEN });
    for (const row of res.rows) {
      assert.match(row, /^[A-Z]+:[A-Z0-9.]+$/, `${row} is EXCH:TICKER`);
    }
  });

  it('short-circuits on a second consecutive call', async () => {
    await screener.get({ screenName: SCREEN });
    await sleep(300);
    const res = await screener.get({ screenName: SCREEN });
    assert.equal(res.success, true, 'second call succeeds');
    assert.equal(res.note, 'already active', 'took the short-circuit path');
    assert.ok(res.rows.length > 0, 'still returns rows');
  });

  it('scrapes the active screen when screenName is omitted', async () => {
    await screener.get({ screenName: SCREEN });
    await sleep(300);
    const res = await screener.get({});
    assert.equal(res.success, true);
    assert.equal(res.screen, SCREEN);
    assert.ok(res.rows.length > 0);
  });

  it('fails loudly on an unknown screen and lists what is available', async () => {
    const res = await screener.get({ screenName: '__no_such_screen__' });
    assert.equal(res.success, false, 'does not fall through to a wrong screen');
    assert.match(res.error, /not found/i);
    assert.ok(Array.isArray(res.available), 'available is a list');
    assert.ok(res.available.length > 0, 'available is non-empty');
    assert.ok(res.available.some(r => r.name === SCREEN), 'the real screen is listed');
  });

  it('restores panel state — closed before, closed after', async () => {
    const opened = await screener.ensureScreenerOpen();
    if (!opened.opened) {
      await screener.closeScreenerPanel();
    }
    await sleep(300);

    const res = await screener.get({ screenName: SCREEN });
    assert.equal(res.success, true);
    await sleep(400);

    const stillOpen = await screener.getActiveScreenName();
    assert.equal(stillOpen, null, 'panel closed again after the call');
  });

  it('restores panel state — open before, open after', async () => {
    await screener.ensureScreenerOpen();
    await sleep(300);

    const res = await screener.get({ screenName: SCREEN });
    assert.equal(res.success, true);
    await sleep(400);

    const name = await screener.getActiveScreenName();
    assert.equal(name, SCREEN, 'panel left open, as it was found');
  });

  it('leaves no dialog open after a failed call', async () => {
    await screener.get({ screenName: '__no_such_screen__' });
    await sleep(400);
    await screener.ensureScreenerOpen();
    const rows = await screener.get({ screenName: SCREEN });
    assert.equal(rows.success, true, 'the next call is unaffected by the failure');
  });
});
```

- [ ] **Step 2: Register the e2e test file**

In `package.json`, append ` tests/screener.core.test.js` to the `test:e2e` script (line 19), after `tests/tools.e2e.test.js`.

- [ ] **Step 3: Run the live suite**

Ensure TradingView Desktop is running, then:

Run: `pnpm exec node --test --test-concurrency=1 tests/screener.core.test.js`
Expected: PASS — 8 tests

If the panel-restore tests fail, revisit the contingency in Task 2 Step 5 (in-page `.click()` versus a CDP mouse click on the Close button).

- [ ] **Step 4: Commit**

```bash
git add tests/screener.core.test.js package.json
git commit -m "test(screener): live e2e coverage for selection, scraping and panel restore"
```

---

### Task 7: Document the tool and open the PR

**Files:**
- Modify: `CLAUDE.md` (add a decision-tree section)

**Interfaces:**
- Consumes: the finished tool.
- Produces: nothing.

- [ ] **Step 1: Document the tool in the decision tree**

In `CLAUDE.md`, add a new section immediately before `### "Navigate the UI"`:

```markdown
### "What's in my screener?"
- `screener_get_rows` → make a saved screen active and return its rows as `EXCH:TICKER[]`
  - `screenName: "Pre-market most active"` → selects that screen, then scrapes
  - omit `screenName` → scrapes whichever screen is already active (no UI churn)
  - returns `{ screen, rows, count, complete, total }`. `complete: false` means the
    result set overflows the panel and `rows` is partial; `total` is always `null`
    because TradingView exposes no result count.
  - fails loudly: an unknown name returns `available[]`, an ambiguous name (the same
    name in both MY SCREENS and POPULAR SCREENS) returns `matches[]`. It never
    guesses a screen.
  - restores the screener panel to the state it found it in.
```

- [ ] **Step 2: Verify the full suite**

Run: `pnpm run test:unit`
Expected: PASS

Run (with TradingView Desktop up): `pnpm run test:e2e`
Expected: PASS

- [ ] **Step 3: Commit and push**

```bash
git add CLAUDE.md
git commit -m "docs: document screener_get_rows in the tool decision tree"
git push -u origin feature/screener-get-rows
```

- [ ] **Step 4: Open the pull request**

```bash
gh pr create --title "feat: screener_get_rows tool" --body "$(cat <<'EOF'
Adds `screener_get_rows` — makes a named saved screen the active TradingView
screener and returns its rows as `EXCH:TICKER[]`.

Design: `docs/superpowers/specs/2026-07-18-screener-get-rows-design.md`

- New DOM-driven `src/core/screener.js`, modelled on `core/watchlist.js`
- Selection goes through the Open-screen dialog only; the title menu's inline
  list is demonstrably partial (5 of 6 saved screens in the probed account)
- Exact match required — an ambiguous name across MY SCREENS / POPULAR SCREENS
  is an error, not a first-match guess
- `complete` is derived from scroll overflow; `total` is always `null` because
  TradingView exposes no result count
- The screener panel is restored to the state it was found in, on every path
- Unit tests are dependency-injected (no browser); e2e tests run live

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01YN1BhyLr6SJxBLh6pSC9n5
EOF
)"
```

---

## Notes for the implementer

- **Why the inline screen list is not used.** Clicking the active-screen title opens a menu that already lists several screens. It is a *recently-used* list: probing an account with six saved screens showed only five, with `Most active` missing. Matching against it would report `not_found` for a screen that exists. The Open-screen dialog is the only authoritative source.
- **Why `.focus()` and not `.click()`.** The title-menu items are custom components. Synthetic `.click()` and dispatched pointer-event sequences silently no-op on them; `.focus()` is reliable. That is why activation is focus-then-real-Enter. This does not apply to genuine `<button>` elements such as the panel Close button — see Task 2 Step 5.
- **Why `ArrowDown` before `Enter`.** With the search box focused, `Enter` alone does not select. The highlight has to move into the result list first.
- **Tool-count strings are stale.** `CLAUDE.md` says 82 tools and `src/server.js` says 78. They already disagree, so this plan does not touch either number rather than guessing which is right. Fix it separately if you want it consistent.
