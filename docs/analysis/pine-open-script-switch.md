# Analysis: `pine_open` Does Not Switch the Active Script Slot

## Symptom

`pine_open` returns `{ success: true }` and updates the Monaco editor text, but TradingView's
title button still shows the previously open script. Saving after `pine_open` writes to the
**old** slot, not the one that was opened.

## Root Cause

`openScript` (in `src/core/pine.js`) fetches the script source via the `pine-facade` API and
calls `m.editor.setValue(source)` on the Monaco editor instance. That is all it does.

Monaco is a text editor. `setValue` replaces the visible text in the buffer — it has no
knowledge of TradingView script slots.

TradingView keeps its own concept of "which script is active" in a React store:

```
fiber depth 7 — hook 7 (useSyncExternalStore)
  memoizedState: {
    scriptIdPart: "USER;353f10bfeed54e68a8bca3ea635bf15f",
    scriptName:   "Watchlist builder",
    scriptTitle:  "Watchlist builder",
    scriptSource: "//@version=6\n...",
    pineVersion:  6,
    cid:          "88e87490-c59e-48d0-9da2-9c4fd5e0d623"
  }
```

This state is managed by an external store connected via `useSyncExternalStore`. The queue on
that hook has only `{ value, getSnapshot }` — no `dispatch`. The store is not directly writable
from outside React.

The `window.scriptUpdater()` async loader exposes a `ScriptUpdater` object whose prototype has:
`onScriptOpen`, `onTVScriptModified`, `onTVScriptDeleted`, `onModifyScriptActiveChanged`. None
of these load a script by ID — `onScriptOpen` only triggers a layout refresh on pane widgets.

**Result:** `m.editor.setValue()` succeeds, so the function returns `{ success: true }`, but the
active slot tracked by TradingView's internal state is unchanged.

## Evidence

The existing code at line 873 already documents this:

```js
// Note: this loads the script's source into the open buffer; TradingView
// still considers the previously open slot active. The tracker lets the
// save paths warn when a save lands in a different slot than expected.
_trackedOpenScript = { id: result.id, name: result.name };
```

`_trackedOpenScript` + `mismatchWarning()` produce a warning when a `save` goes to the wrong
slot, but do not prevent it.

## Fix Approach: UI Navigation

The only reliable way to switch the active slot is to drive TradingView's own "Open script"
flow. Confirmed selectors (verified live on 2026-06-14):

| Step | Selector / Action |
|------|-------------------|
| 1 | Click `[class*="nameButton"][aria-haspopup="menu"]` — opens the script menu |
| 2 | Click `[role="menuitem"]` whose text matches `/open script/i` |
| 3 | Wait for `input.input-qm7Rg5MB` (search box in the "Open my script" dialog) |
| 4 | Type the target script name into that input |
| 5 | Wait for `[class*="itemRow-gisYB8vu"]` items to filter |
| 6 | Click the item whose `.titleText-gisYB8vu` text matches the target name |
| 7 | TradingView internally updates the React store and the title button |

After step 6 TradingView also recompiles, so `pollForDialog` should run to handle any
pending-changes prompt triggered by the switch.

### Why not the internal API?

Tried and ruled out:
- `window.scriptUpdater()` — no load-by-ID method
- React fiber `dispatch` on the `useSyncExternalStore` hook — hook has no `dispatch`, only
  `getSnapshot`. The snapshot is read-only from outside.
- Walking fiber props/stateNode up 80 levels from the nameButton — no `loadScript` method found

## Impact on Existing Code

The `pine-facade` fetch in `openScript` still has value: it can validate that the target script
exists and resolve ambiguous names before launching the UI flow. The fix is to replace the
`m.editor.setValue()` call with the UI navigation above.

The `_trackedOpenScript` tracking and `mismatchWarning()` in `save` should be kept — they remain
useful as a safety net if the dialog is dismissed mid-flow.
