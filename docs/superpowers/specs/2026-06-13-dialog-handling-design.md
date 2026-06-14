# Dialog Handling — Design Spec

**Date:** 2026-06-13
**Status:** Approved

## Problem

TradingView shows modal dialogs asynchronously after certain operations (script navigation, layout switching, saving). The current code checks for these dialogs once after a fixed sleep. If TradingView renders the dialog after that window, the tool returns success while the UI is left blocked. Subsequent tool calls appear to succeed (JS evaluation bypasses the modal) but act on a stuck UI.

Two dialog types are affected:

- **Pending-changes dialog** — appears when navigating away from a dirty Pine editor buffer. Buttons: "Save", "Don't save / Discard", "Cancel".
- **Override confirmation** — appears when saving a script that already has a saved version. Buttons: "Yes", "OK", "Confirm".

## Decision Rules

| Dialog type | Action |
|---|---|
| Pending changes (navigating away) | Always click "Don't save / Discard" |
| Override confirmation (saving) | Always click "Yes / OK / Confirm" |

Both are handled silently. No error is raised; the result object may optionally include `dialog_dismissed` for transparency.

## Architecture

### New module: `src/core/dialog.js`

Single exported function:

```js
export async function pollForDialog(d, { maxMs = 2400, interval = 300 } = {})
```

**Parameters:**
- `d` — resolved deps object `{ evaluate, sleep }`, same pattern used throughout `core/`
- `maxMs` — total polling budget in ms (default 2400)
- `interval` — time between ticks in ms (default 300)

**Returns:**
```js
{ handled: bool, action: 'discard' | 'confirm' | null, button_text: string | null, elapsed_ms: number }
```

Exits immediately on first handled dialog. If no dialog appears within `maxMs`, returns `{ handled: false, action: null, button_text: null, elapsed_ms }`.

### Detection logic

Each tick runs a single JS expression with two passes:

**Pass 1 — pending-changes patterns (global scan)**

Matched anywhere in the DOM. These button texts are specific enough to only appear in the navigation-away dialog:

| Button text | Action |
|---|---|
| `don't save` / `don`t save` (smart quote variant) | discard |
| `discard changes` | discard |
| `discard` (exact) | discard |

**Pass 2 — override-confirmation patterns (scoped to dialog containers)**

Matched only within elements having a dialog ancestor (`[role="dialog"]`, `[class*="dialog"]`, `[class*="modal"]`, `[class*="popup"]`). Prevents false-positive clicks on permanently-visible page buttons:

| Button text | Action |
|---|---|
| `yes` (exact) | confirm |
| `ok` (exact) | confirm |
| `confirm` (exact) | confirm |

Both passes use `getClientRects().length > 0` for visibility. `position:fixed` dialogs return no `offsetParent` but do return rects — this is the correct check.

Note: "Save" is intentionally excluded from pass 2. The existing `saveNameDialogExpr` in `save()` already handles the "Save script" name dialog. Adding "Save" to the poller risks double-handling. It can be added scoped to `[role="dialog"]` if a real failure case emerges.

## Call Sites

Four locations get `pollForDialog` added. Calling convention is reactive — only after actions known to produce dialogs.

### 1. `core/pine.js` — `newScript`

After `sleep(600)`, replace the inline one-shot `__dismissUnsavedChangesDialog` expression with `await pollForDialog(d)`. The 600ms pre-sleep stays (lets TradingView begin rendering the menu transition); the poller covers the remaining async render time.

### 2. `core/pine.js` — `save`

After the existing `saveNameDialogExpr` call, add `await pollForDialog(d)` to catch override confirmations. The save-name dialog and override confirmation are mutually exclusive in practice.

### 3. `core/ui.js` — `layoutSwitch`

Replace the 500ms sleep + inline one-shot dismiss expression with `await pollForDialog(d)`. `layoutSwitch` imports `evaluate` directly rather than using `_resolve(deps)` — pass `{ evaluate, sleep: (ms) => new Promise(r => setTimeout(r, ms)) }` as `d`.

### 4. `core/pine.js` — `openScript`

After `evaluateAsync` completes (the call that performs `m.editor.setValue()`), add `await pollForDialog(d)`. TradingView may detect the buffer change and surface a dialog in response to the direct Monaco injection.

## Out of Scope

- `smartCompile` — no observed failures; excluded per YAGNI.
- Proactive guard (checking for stuck dialogs at the start of every tool) — excluded; reactive-only is sufficient and avoids per-call overhead.
- Surfacing dialog state to callers as errors — both dialog types are handled silently.
