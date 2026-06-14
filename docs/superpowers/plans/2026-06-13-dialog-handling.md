# Dialog Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace one-shot dialog checks in `newScript`, `save`, `openScript`, and `layoutSwitch` with a shared `pollForDialog` utility that retries until a dialog appears or a tick budget expires.

**Architecture:** A new `src/core/dialog.js` module exports `pollForDialog(d, opts)`. It runs a two-pass DOM scan on each tick — pass 1 discards pending-changes dialogs globally, pass 2 confirms override dialogs scoped to dialog containers. Four call sites in `pine.js` and `ui.js` import and call it after actions that are known to produce dialogs.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert/strict`. No new dependencies.

---

## File Map

| Action | File | Purpose |
|---|---|---|
| Create | `src/core/dialog.js` | `pollForDialog` — the only export |
| Create | `tests/dialog.test.js` | Unit tests for `pollForDialog` |
| Modify | `src/core/pine.js` | `newScript`, `save`, `openScript` call sites |
| Modify | `src/core/ui.js` | `layoutSwitch` call site |
| Modify | `package.json` | Add `dialog.test.js` to `test:unit` / `test:all` |

---

## Task 1: Create `src/core/dialog.js` and its tests

**Files:**
- Create: `src/core/dialog.js`
- Create: `tests/dialog.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write the failing tests**

Create `tests/dialog.test.js`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pollForDialog } from '../src/core/dialog.js';

function makeDeps({ responses = [{ handled: false }] } = {}) {
  let idx = 0;
  const calls = [];
  return {
    calls,
    d: {
      evaluate: async (expr) => {
        calls.push(expr);
        if (expr.includes('__dismissDialog')) {
          const r = responses[Math.min(idx, responses.length - 1)];
          idx++;
          return r;
        }
        return undefined;
      },
      sleep: async () => {},
    },
  };
}

describe('pollForDialog()', () => {
  it('returns handled:false when no dialog appears within the tick budget', async () => {
    const { d } = makeDeps({ responses: [{ handled: false }] });
    const result = await pollForDialog(d, { maxMs: 300, interval: 100 });
    assert.equal(result.handled, false);
    assert.equal(result.action, null);
    assert.equal(result.button_text, null);
  });

  it('returns handled:true with action:discard when pending-changes dialog found', async () => {
    const { d } = makeDeps({ responses: [{ handled: true, action: 'discard', button_text: "Don't save" }] });
    const result = await pollForDialog(d, { maxMs: 300, interval: 100 });
    assert.equal(result.handled, true);
    assert.equal(result.action, 'discard');
    assert.equal(result.button_text, "Don't save");
  });

  it('returns handled:true with action:confirm when override dialog found', async () => {
    const { d } = makeDeps({ responses: [{ handled: true, action: 'confirm', button_text: 'Yes' }] });
    const result = await pollForDialog(d, { maxMs: 300, interval: 100 });
    assert.equal(result.handled, true);
    assert.equal(result.action, 'confirm');
    assert.equal(result.button_text, 'Yes');
  });

  it('exits on the first handled result without exhausting the tick budget', async () => {
    const { d, calls } = makeDeps({
      responses: [{ handled: true, action: 'discard', button_text: 'Discard' }],
    });
    await pollForDialog(d, { maxMs: 2400, interval: 300 });
    const dialogCalls = calls.filter(e => e.includes('__dismissDialog'));
    assert.equal(dialogCalls.length, 1);
  });

  it('polls multiple ticks before the dialog appears', async () => {
    const { d, calls } = makeDeps({
      responses: [
        { handled: false },
        { handled: false },
        { handled: true, action: 'discard', button_text: 'Discard' },
      ],
    });
    const result = await pollForDialog(d, { maxMs: 900, interval: 300 });
    assert.equal(result.handled, true);
    const dialogCalls = calls.filter(e => e.includes('__dismissDialog'));
    assert.equal(dialogCalls.length, 3);
  });

  it('includes elapsed_ms as a non-negative number', async () => {
    const { d } = makeDeps();
    const result = await pollForDialog(d, { maxMs: 300, interval: 100 });
    assert.equal(typeof result.elapsed_ms, 'number');
    assert.ok(result.elapsed_ms >= 0);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
node --test tests/dialog.test.js
```

Expected: all 6 tests fail with `Cannot find module '../src/core/dialog.js'`.

- [ ] **Step 3: Implement `src/core/dialog.js`**

Create `src/core/dialog.js`:

```javascript
/**
 * Dialog detection and dismissal for TradingView MCP.
 * Reactive-only: call after actions known to produce modal dialogs.
 */

const POLL_DIALOG_EXPR = `
  (function __dismissDialog() {
    var btns = document.querySelectorAll('button');

    // Pass 1: pending-changes patterns — safe to match globally (specific text)
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      if (!btn.getClientRects().length) continue;
      var t = (btn.textContent || '').trim();
      if (/don.?t save|discard changes|^discard$/i.test(t)) {
        btn.click();
        return { handled: true, action: 'discard', button_text: t };
      }
    }

    // Pass 2: override-confirmation patterns — scoped to dialog containers only
    var containers = document.querySelectorAll('[role="dialog"], [class*="dialog"], [class*="modal"], [class*="popup"]');
    for (var c = 0; c < containers.length; c++) {
      var dlgBtns = containers[c].querySelectorAll('button');
      for (var j = 0; j < dlgBtns.length; j++) {
        var btn2 = dlgBtns[j];
        if (!btn2.getClientRects().length) continue;
        var t2 = (btn2.textContent || '').trim();
        if (/^(yes|ok|confirm)$/i.test(t2)) {
          btn2.click();
          return { handled: true, action: 'confirm', button_text: t2 };
        }
      }
    }

    return { handled: false };
  })()
`;

/**
 * Polls for a dismissible TradingView dialog and handles it.
 * Uses a fixed tick budget (maxMs / interval) so zero-delay test mocks
 * run a predictable number of iterations without spinning on real wall time.
 *
 * @param {{ evaluate: Function, sleep: Function }} d - resolved deps
 * @param {{ maxMs?: number, interval?: number }} opts
 * @returns {{ handled: boolean, action: string|null, button_text: string|null, elapsed_ms: number }}
 */
export async function pollForDialog(d, { maxMs = 2400, interval = 300 } = {}) {
  const start = Date.now();
  const maxTicks = Math.ceil(maxMs / interval);
  for (let i = 0; i < maxTicks; i++) {
    const result = await d.evaluate(POLL_DIALOG_EXPR);
    if (result?.handled) {
      return { handled: true, action: result.action, button_text: result.button_text, elapsed_ms: Date.now() - start };
    }
    await d.sleep(interval);
  }
  return { handled: false, action: null, button_text: null, elapsed_ms: Date.now() - start };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
node --test tests/dialog.test.js
```

Expected: all 6 tests pass.

- [ ] **Step 5: Add `dialog.test.js` to `package.json` test scripts**

In `package.json`, update `test:unit` and `test:all` to include `tests/dialog.test.js`:

```json
"test:unit": "node --test tests/pine_analyze.test.js tests/cli.test.js tests/sanitization.test.js tests/pine_lifecycle.test.js tests/dialog.test.js",
"test:all": "node --test tests/e2e.test.js tests/pine_analyze.test.js tests/cli.test.js tests/sanitization.test.js tests/pine_lifecycle.test.js tests/dialog.test.js",
```

- [ ] **Step 6: Run full unit suite to confirm no regressions**

```
pnpm test:unit
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/dialog.js tests/dialog.test.js package.json
git commit -m "feat(dialog): add pollForDialog utility with two-pass dialog detection"
```

---

## Task 2: Update `newScript` to use `pollForDialog`

**Files:**
- Modify: `src/core/pine.js` (import + `newScript` function)
- Modify: `tests/pine_lifecycle.test.js` (update `makeDeps`, update existing test, add new test)

- [ ] **Step 1: Add new failing test and update `makeDeps` in `pine_lifecycle.test.js`**

In `makeDeps` (around line 27), replace the `unsavedDialog` parameter with `dialogResult`:

```javascript
function makeDeps({
  lists = [[SCRIPT_A, SCRIPT_B]],
  titleMenu = { clicked: true, label: 'Script A' },
  createNewItem = { clicked: true },
  newMenuItem = { clicked: true, label: 'Indicator' },
  dialogResult = { handled: false },
  saveNameDialog = { handled: true },
  compileButton = 'Pine Save',
  editorSaveButton = { clicked: true },
  openScriptResult = { success: true, name: 'Script A', id: 'USER;aaa', lines: 10 },
} = {}) {
```

In the handler function inside `makeDeps`, replace:

```javascript
    if (expr.includes('__dismissUnsavedChangesDialog')) { return unsavedDialog; }
```

with:

```javascript
    if (expr.includes('__dismissDialog')) { return dialogResult; }
    if (expr.includes('pine-facade/list') && expr.includes('setValue')) { return openScriptResult; }
```

The `pine-facade/list && setValue` guard differentiates `openScript`'s evaluateAsync (which includes both) from `fetchScriptList` (which only has `pine-facade/list`).

Then update the existing "dismisses an unsaved-changes prompt" test (around line 188) to use the new field name and marker:

```javascript
  it('dismisses an unsaved-changes prompt without saving the old buffer', async () => {
    const m = makeDeps({
      lists: [[SCRIPT_A], [SCRIPT_A, SCRIPT_NEW]],
      dialogResult: { handled: true, action: 'discard', button_text: "Don't save" },
    });
    const result = await newScript({ type: 'indicator', _deps: m._deps });
    assert.equal(result.success, true);
    const dismissCall = m.calls.find(c => c.includes('__dismissDialog'));
    assert.ok(dismissCall, 'expected pollForDialog call for pending-changes dialog');
  });
```

Add a new test at the end of the `newScript` describe block:

```javascript
  it('calls pollForDialog after menu navigation (not a one-shot check)', async () => {
    const m = makeDeps({ lists: [[SCRIPT_A], [SCRIPT_A, SCRIPT_NEW]] });
    await newScript({ type: 'indicator', _deps: m._deps });
    const dialogCalls = m.calls.filter(c => c.includes('__dismissDialog'));
    assert.ok(dialogCalls.length > 0, 'expected at least one pollForDialog evaluate call');
  });
```

- [ ] **Step 2: Run tests to confirm the new test fails**

```
node --test tests/pine_lifecycle.test.js
```

Expected: "calls pollForDialog after menu navigation" fails (`__dismissDialog` not found in calls), the updated "dismisses an unsaved-changes prompt" test also fails (still uses `__dismissUnsavedChangesDialog`).

- [ ] **Step 3: Import `pollForDialog` and update `newScript` in `src/core/pine.js`**

At the top of `src/core/pine.js`, add the import after the existing import:

```javascript
import { pollForDialog } from './dialog.js';
```

Inside `newScript`, locate the block (around line 756) that currently reads:

```javascript
  const dialog = await d.evaluate(`
    (function __dismissUnsavedChangesDialog() {
      var btns = document.querySelectorAll('button');
      var sawSave = false;
      for (var i = 0; i < btns.length; i++) {
        var btn = btns[i];
        if (!btn.getClientRects().length) continue;
        var t = (btn.textContent || '').trim();
        if (/don.?t save|discard changes|^discard$/i.test(t)) {
          btn.click();
          return { found: true, action: t };
        }
        if (/^save( changes)?$/i.test(t)) sawSave = true;
      }
      // A lone Save button with no discard option means an unexpected dialog.
      return { found: false, ambiguous: sawSave };
    })()
  `);
  if (dialog?.found) await d.sleep(400);
```

Replace it with:

```javascript
  const dialog = await pollForDialog(d);
  if (dialog.handled) await d.sleep(400);
```

- [ ] **Step 4: Run tests to confirm they pass**

```
node --test tests/pine_lifecycle.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/pine.js tests/pine_lifecycle.test.js
git commit -m "feat(dialog): use pollForDialog in newScript (replaces one-shot dismiss)"
```

---

## Task 3: Update `save` to use `pollForDialog`

**Files:**
- Modify: `src/core/pine.js` (`save` function)
- Modify: `tests/pine_lifecycle.test.js` (new test in the `save` describe block)

- [ ] **Step 1: Add a failing test to the `save` describe block in `pine_lifecycle.test.js`**

Add at the end of the `save()` describe block (after the "warns when the saved slot differs" test, around line 228):

```javascript
  it('polls for override confirmation dialog after save-name dialog', async () => {
    const bumped = { ...SCRIPT_A, version: '6.0', modified: 1500 };
    const m = makeDeps({ lists: [[SCRIPT_A, SCRIPT_B], [bumped, SCRIPT_B]] });
    await save({ _deps: m._deps });
    const dialogCalls = m.calls.filter(c => c.includes('__dismissDialog'));
    assert.ok(dialogCalls.length > 0, 'expected pollForDialog call after Ctrl+S in save()');
  });
```

- [ ] **Step 2: Run to confirm it fails**

```
node --test tests/pine_lifecycle.test.js
```

Expected: "polls for override confirmation dialog after save-name dialog" fails (`__dismissDialog` not found).

- [ ] **Step 3: Update `save` in `src/core/pine.js`**

In `save`, locate (around line 514):

```javascript
  // Handle "Save Script" name dialog that appears for new/unsaved scripts
  const dialog = await d.evaluate(saveNameDialogExpr(null));
  if (dialog?.handled) await d.sleep(500);

  const { saved_to, note } = await resolveSaveTarget(d, before);
  return applySaveTracking(
    { success: true, action: dialog?.handled ? 'saved_with_dialog' : 'Ctrl+S_dispatched' },
    saved_to, note
  );
```

Replace with:

```javascript
  // Handle "Save Script" name dialog that appears for new/unsaved scripts
  const nameDialog = await d.evaluate(saveNameDialogExpr(null));
  if (nameDialog?.handled) await d.sleep(500);

  // Handle override confirmation that appears when saving existing scripts
  await pollForDialog(d);

  const { saved_to, note } = await resolveSaveTarget(d, before);
  return applySaveTracking(
    { success: true, action: nameDialog?.handled ? 'saved_with_dialog' : 'Ctrl+S_dispatched' },
    saved_to, note
  );
```

- [ ] **Step 4: Run tests to confirm they pass**

```
node --test tests/pine_lifecycle.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/pine.js tests/pine_lifecycle.test.js
git commit -m "feat(dialog): poll for override confirmation in save()"
```

---

## Task 4: Update `openScript` to use `pollForDialog`

**Files:**
- Modify: `src/core/pine.js` (`openScript` function)
- Modify: `tests/pine_lifecycle.test.js` (new test in the `openScript` describe block)

- [ ] **Step 1: Add a failing test to the `openScript` describe block in `pine_lifecycle.test.js`**

Add after the existing "records the opened script" test (around line 289):

```javascript
  it('polls for dialogs after injecting source into Monaco', async () => {
    const calls = [];
    const handler = async (expr) => {
      calls.push(expr);
      if (expr.includes('pine-facade/list')) {
        return { success: true, name: 'Script A', id: 'USER;aaa', lines: 3 };
      }
      if (expr.includes('findMonacoEditor')) { return true; }
      return undefined;
    };
    const _deps = { evaluate: handler, evaluateAsync: handler, sleep: async () => {} };
    await openScript({ name: 'Script A', _deps });
    assert.ok(
      calls.some(c => c.includes('__dismissDialog')),
      'expected pollForDialog evaluate call after setValue'
    );
  });
```

- [ ] **Step 2: Run to confirm it fails**

```
node --test tests/pine_lifecycle.test.js
```

Expected: "polls for dialogs after injecting source into Monaco" fails (`__dismissDialog` not found).

- [ ] **Step 3: Update `openScript` in `src/core/pine.js`**

In `openScript`, replace:

```javascript
  const { evaluateAsync } = _resolve(_deps);
```

with:

```javascript
  const { evaluate, evaluateAsync, sleep } = _resolve(_deps);
```

Then, after the `if (result?.error)` throw (around line 883), add one line:

```javascript
  if (result?.error) {
    throw new Error(result.error);
  }

  await pollForDialog({ evaluate, sleep });

  _trackedOpenScript = { id: result.id, name: result.name };
```

- [ ] **Step 4: Run tests to confirm they pass**

```
node --test tests/pine_lifecycle.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/pine.js tests/pine_lifecycle.test.js
git commit -m "feat(dialog): poll for dialogs after openScript setValue"
```

---

## Task 5: Update `layoutSwitch` to use `pollForDialog`

**Files:**
- Modify: `src/core/ui.js`

Note: `layoutSwitch` uses module-level imports rather than deps injection, so no unit test is added here. The `pollForDialog` behavior is fully covered by `tests/dialog.test.js`. Regression coverage is via e2e.

- [ ] **Step 1: Add the import to `src/core/ui.js`**

At the top of `src/core/ui.js`, add after the existing import:

```javascript
import { pollForDialog } from './dialog.js';
```

- [ ] **Step 2: Replace the one-shot dismiss block in `layoutSwitch`**

In `layoutSwitch` (around line 143), locate:

```javascript
  // Handle "unsaved changes" confirmation dialog
  await new Promise(r => setTimeout(r, 500));
  const dismissed = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/open anyway|don't save|discard/i.test(text)) {
          btns[i].click();
          return true;
        }
      }
      return false;
    })()
  `);

  if (dismissed) await new Promise(r => setTimeout(r, 1000));
  return { success: true, layout: result.name || name, layout_id: result.id, source: result.source, action: 'switched', unsaved_dialog_dismissed: dismissed };
```

Replace with:

```javascript
  const _d = { evaluate, sleep: (ms) => new Promise(r => setTimeout(r, ms)) };
  const dialog = await pollForDialog(_d);
  return { success: true, layout: result.name || name, layout_id: result.id, source: result.source, action: 'switched', unsaved_dialog_dismissed: dialog.handled };
```

- [ ] **Step 3: Run the full unit suite**

```
pnpm test:unit
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/core/ui.js
git commit -m "feat(dialog): use pollForDialog in layoutSwitch (replaces one-shot dismiss)"
```
