/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, getClient as _getClient } from '../connection.js';
import { pollForDialog } from './dialog.js';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    getClient: deps?.getClient || _getClient,
    sleep: deps?.sleep || ((ms) => new Promise(r => setTimeout(r, ms))),
  };
}

// ── Open-script tracking (guard rail against overwriting the wrong slot) ──
// The MCP server is long-running, so this survives across tool calls within
// a session. It records what the caller last opened/created so save paths
// can warn when the actually-saved slot differs.
let _trackedOpenScript = null;

export function getTrackedOpenScript() {
  return _trackedOpenScript;
}

export function _setTrackedOpenScript(value) {
  _trackedOpenScript = value;
}

// ── Monaco finder (injected into TV page) ──
const FIND_MONACO = `
  (function findMonacoEditor() {
    var container = document.querySelector('.monaco-editor.pine-editor-monaco');
    if (!container) return null;
    var el = container;
    var fiberKey;
    for (var i = 0; i < 20; i++) {
      if (!el) break;
      fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
      if (fiberKey) break;
      el = el.parentElement;
    }
    if (!fiberKey) return null;
    var current = el[fiberKey];
    for (var d = 0; d < 15; d++) {
      if (!current) break;
      if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
        var env = current.memoizedProps.value.monacoEnv;
        if (env.editor && typeof env.editor.getEditors === 'function') {
          var editors = env.editor.getEditors();
          if (editors.length > 0) return { editor: editors[0], env: env };
        }
      }
      current = current.return;
    }
    return null;
  })()
`;

/**
 * Opens the Pine Editor panel and waits for Monaco to become available.
 * Returns true if editor is accessible, false on timeout.
 */
export async function ensurePineEditorOpen(_deps) {
  const { evaluate, sleep } = _resolve(_deps);
  const already = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      return m !== null;
    })()
  `);
  if (already) return true;

  await evaluate(`
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return;
      if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
      else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
    })()
  `);

  await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Pine"]')
        || document.querySelector('[data-name="pine-dialog-button"]');
      if (btn) btn.click();
    })()
  `);

  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const ready = await evaluate(`(function() { return ${FIND_MONACO} !== null; })()`);
    if (ready) return true;
  }
  return false;
}

// Reads the open script's name from the editor's title button — this is the
// slot a save will write into, regardless of what was injected into the buffer.
const READ_OPEN_SCRIPT_NAME = `
  (function __readOpenScriptName() {
    // The title element is a DIV with aria-haspopup="menu", not a <button>
    var btn = document.querySelector('[class*="nameButton"][aria-haspopup]');
    if (!btn) return null;
    return (btn.textContent || '').trim() || null;
  })()
`;

// ── Pure / offline functions ──

export function analyze({ source }) {
  const lines = source.split('\n');
  const diagnostics = [];

  let isV6 = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//@version=6')) { isV6 = true; break; }
    if (trimmed.startsWith('//@version=')) break;
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    break;
  }

  const arrays = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromMatch = line.match(/(\w+)\s*=\s*array\.from\(([^)]*)\)/);
    if (fromMatch) {
      const name = fromMatch[1].trim();
      const args = fromMatch[2].trim();
      const size = args === '' ? 0 : args.split(',').length;
      arrays.set(name, { name, size, line: i + 1 });
      continue;
    }
    const newMatch = line.match(/(\w+)\s*=\s*array\.new(?:<\w+>|_\w+)\((\d+)?/);
    if (newMatch) {
      const name = newMatch[1].trim();
      const size = newMatch[2] !== undefined ? parseInt(newMatch[2], 10) : null;
      arrays.set(name, { name, size, line: i + 1 });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pattern = /array\.(get|set)\(\s*(\w+)\s*,\s*(-?\d+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const method = match[1];
      const arrName = match[2];
      const idx = parseInt(match[3], 10);
      const info = arrays.get(arrName);
      if (!info || info.size === null) continue;
      if (idx < 0 || idx >= info.size) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `array.${method}(${arrName}, ${idx}) — index ${idx} out of bounds (array size is ${info.size})`,
          severity: 'error',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstLastPattern = /(\w+)\.(first|last)\(\)/g;
    let match;
    while ((match = firstLastPattern.exec(line)) !== null) {
      const arrName = match[1];
      if (arrName === 'array') continue;
      const info = arrays.get(arrName);
      if (info && info.size === 0) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `${arrName}.${match[2]}() called on possibly empty array (declared with size 0)`,
          severity: 'warning',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.includes('strategy.entry') || trimmed.includes('strategy.close')) {
      let hasStrategyDecl = false;
      for (const l of lines) {
        if (l.trim().startsWith('strategy(')) { hasStrategyDecl = true; break; }
      }
      if (!hasStrategyDecl) {
        diagnostics.push({
          line: i + 1, column: 1,
          message: 'strategy.entry/close used but no strategy() declaration found — did you mean to use indicator()?',
          severity: 'error',
        });
        break;
      }
    }
  }

  if (!isV6 && source.includes('//@version=')) {
    const vMatch = source.match(/\/\/@version=(\d+)/);
    if (vMatch && parseInt(vMatch[1]) < 5) {
      diagnostics.push({
        line: 1, column: 1,
        message: `Script uses Pine v${vMatch[1]} — consider upgrading to v6 for latest features`,
        severity: 'info',
      });
    }
  }

  return {
    success: true,
    issue_count: diagnostics.length,
    diagnostics,
    note: diagnostics.length === 0 ? 'No static analysis issues found. Use pine_compile or pine_smart_compile for full server-side compilation check.' : undefined,
  };
}

export async function check({ source }) {
  const formData = new URLSearchParams();
  formData.append('source', source);

  const response = await fetch(
    'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.tradingview.com/',
      },
      body: formData,
    }
  );

  if (!response.ok) {
    throw new Error(`TradingView API returned ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  const errors = [];
  const warnings = [];
  const inner = result?.result;

  if (inner) {
    if (inner.errors2 && inner.errors2.length > 0) {
      for (const e of inner.errors2) {
        errors.push({
          line: e.start?.line, column: e.start?.column,
          end_line: e.end?.line, end_column: e.end?.column,
          message: e.message,
        });
      }
    }
    if (inner.warnings2 && inner.warnings2.length > 0) {
      for (const w of inner.warnings2) {
        warnings.push({ line: w.start?.line, column: w.start?.column, message: w.message });
      }
    }
  }

  if (result.error && typeof result.error === 'string') {
    errors.push({ message: result.error });
  }

  const compiled = errors.length === 0;
  return {
    success: true,
    compiled,
    error_count: errors.length,
    warning_count: warnings.length,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    note: compiled ? 'Pine Script compiled successfully.' : undefined,
  };
}

// ── Functions requiring TradingView connection ──

export async function getSource({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const editorReady = await ensurePineEditorOpen(_deps);
  if (!editorReady) throw new Error('Could not open Pine Editor or Monaco not found in React fiber tree.');

  const source = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return null;
      return m.editor.getValue();
    })()
  `);

  if (source === null || source === undefined) {
    throw new Error('Monaco editor found but getValue() returned null.');
  }

  const openScriptName = await evaluate(READ_OPEN_SCRIPT_NAME);
  return { success: true, open_script: openScriptName ?? null, source, line_count: source.split('\n').length, char_count: source.length };
}

export async function setSource({ source, _deps }) {
  const { evaluate } = _resolve(_deps);
  const editorReady = await ensurePineEditorOpen(_deps);
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const escaped = JSON.stringify(source);
  const set = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);

  if (!set) throw new Error('Monaco found but setValue() failed.');
  const openScriptName = await evaluate(READ_OPEN_SCRIPT_NAME);
  return {
    success: true,
    open_script: openScriptName ?? null,
    lines_set: source.split('\n').length,
    note: openScriptName ? `Source injected into the buffer of open script "${openScriptName}" — a save/compile will write into that slot.` : undefined,
  };
}

export async function compile({ _deps } = {}) {
  const { evaluate, getClient, sleep } = _resolve(_deps);
  const editorReady = await ensurePineEditorOpen(_deps);
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const clicked = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      var fallback = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!fallback && /^(Add to chart|Update on chart)/i.test(text)) {
          fallback = btns[i];
        }
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) {
          saveBtn = btns[i];
        }
      }
      if (fallback) { fallback.click(); return fallback.textContent.trim(); }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  if (!clicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await sleep(2000);
  return { success: true, button_clicked: clicked || 'keyboard_shortcut', source: 'dom_fallback' };
}

export async function getErrors({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const editorReady = await ensurePineEditorOpen(_deps);
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  return {
    success: true,
    has_errors: errors?.length > 0,
    error_count: errors?.length || 0,
    errors: errors || [],
  };
}

// ── Script-list helpers (pine-facade, session cookies) ───────────────────

async function fetchScriptList(evaluateAsync) {
  const data = await evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(list) {
        if (!Array.isArray(list)) return { scripts: null, error: 'Unexpected response from pine-facade' };
        return {
          scripts: list.map(function(s) {
            return {
              id: s.scriptIdPart || null,
              name: s.scriptName || s.scriptTitle || 'Untitled',
              title: s.scriptTitle || null,
              version: s.version || null,
              modified: s.modified || null,
            };
          })
        };
      })
      .catch(function(e) { return { scripts: null, error: e.message }; })
  `);
  return { scripts: data?.scripts ?? null, error: data?.error };
}

/**
 * Compares two saved-script lists and returns the script a save wrote into:
 * a new id (`change: 'created'`) or a version/modified bump (`change: 'updated'`).
 * Returns null when nothing changed or either list is unavailable.
 */
export function diffScriptLists(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return null;
  const byId = new Map(before.map(s => [s.id, s]));
  for (const s of after) {
    const prev = byId.get(s.id);
    if (!prev) return { ...s, change: 'created' };
    if (prev.version !== s.version || prev.modified !== s.modified) return { ...s, change: 'updated' };
  }
  return null;
}

/**
 * Polls the saved-script list after a save action and resolves which slot
 * was written. Returns { saved_to, note? }.
 */
async function resolveSaveTarget(d, before, { polls = 6 } = {}) {
  if (!before.scripts) {
    return { saved_to: null, note: `Could not determine save target: saved-script list unavailable (${before.error}).` };
  }
  for (let i = 0; i < polls; i++) {
    const after = await fetchScriptList(d.evaluateAsync);
    const diff = diffScriptLists(before.scripts, after.scripts);
    if (diff) {
      return { saved_to: { id: diff.id, name: diff.name, version: diff.version, change: diff.change } };
    }
    await d.sleep(700);
  }
  return { saved_to: null, note: 'No saved script changed after this action (nothing was written to the cloud, or the list has not updated yet).' };
}

function mismatchWarning(savedTo) {
  if (!savedTo || !_trackedOpenScript) return null;
  if (savedTo.id === _trackedOpenScript.id) return null;
  return `Save wrote into "${savedTo.name}" (${savedTo.id}) but the last opened/created script was "${_trackedOpenScript.name}" (${_trackedOpenScript.id}). A different saved script may have been overwritten — check its version history on TradingView if this was unintended.`;
}

function applySaveTracking(result, savedTo, note) {
  result.saved_to = savedTo;
  if (note) result.note = note;
  const warning = mismatchWarning(savedTo);
  if (warning) result.warning = warning;
  else if (savedTo) _trackedOpenScript = { id: savedTo.id, name: savedTo.name };
  return result;
}

/**
 * Handles the "Save script" name dialog that appears when saving an unsaved
 * script. Optionally types a requested name before confirming.
 * The expression returns { handled, named }.
 */
function saveNameDialogExpr(name) {
  return `
    (function __handleSaveNameDialog() {
      var requestedName = ${name ? JSON.stringify(name) : 'null'};
      // The save dialog wrapper is position:fixed (offsetParent === null), so
      // locate the visible "Save" button first, then climb to its dialog to
      // reach the name input (which lives in a sibling subtree).
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var btn = btns[i];
        if (!btn.getClientRects().length) continue;
        if (!/^save$/i.test((btn.textContent || '').trim())) continue;
        var dlg = btn.closest('[class*="popupDialog"], [class*="dialog"], [role="dialog"]') || btn.parentElement;
        var named = false;
        var input = dlg ? dlg.querySelector('input[type="text"], input:not([type])') : null;
        if (input && requestedName) {
          var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, requestedName);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          named = true;
        }
        btn.click();
        return { handled: true, named: named };
      }
      return { handled: false };
    })()
  `;
}

export async function save({ _deps } = {}) {
  const d = _resolve(_deps);
  const editorReady = await ensurePineEditorOpen(_deps);
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const before = await fetchScriptList(d.evaluateAsync);

  const c = await d.getClient();
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });
  await d.sleep(800);

  // Handle "Save Script" name dialog that appears for new/unsaved scripts
  const dialog = await d.evaluate(saveNameDialogExpr(null));
  if (dialog?.handled) await d.sleep(500);

  const { saved_to, note } = await resolveSaveTarget(d, before);
  return applySaveTracking(
    { success: true, action: dialog?.handled ? 'saved_with_dialog' : 'Ctrl+S_dispatched' },
    saved_to, note
  );
}

export async function getConsole({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const editorReady = await ensurePineEditorOpen(_deps);
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const entries = await evaluate(`
    (function() {
      var results = [];
      var rows = document.querySelectorAll('[class*="consoleRow"], [class*="log-"], [class*="consoleLine"]');
      if (rows.length === 0) {
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]')
          || document.querySelector('[class*="bottom-widgetbar-content"]');
        if (bottomArea) {
          rows = bottomArea.querySelectorAll('[class*="message"], [class*="log"], [class*="console"]');
        }
      }
      if (rows.length === 0) {
        var pinePanel = document.querySelector('.pine-editor-container')
          || document.querySelector('[class*="pine-editor"]')
          || document.querySelector('[class*="layout__area--bottom"]');
        if (pinePanel) {
          var allSpans = pinePanel.querySelectorAll('span, div');
          for (var s = 0; s < allSpans.length; s++) {
            var txt = allSpans[s].textContent.trim();
            if (/^\\d{2}:\\d{2}:\\d{2}/.test(txt) || /error|warning|info/i.test(allSpans[s].className)) {
              rows = Array.from(rows || []);
              rows.push(allSpans[s]);
            }
          }
        }
      }
      for (var i = 0; i < rows.length; i++) {
        var text = rows[i].textContent.trim();
        if (!text) continue;
        var ts = null;
        var tsMatch = text.match(/^(\\d{4}-\\d{2}-\\d{2}\\s+)?\\d{2}:\\d{2}:\\d{2}/);
        if (tsMatch) ts = tsMatch[0];
        var type = 'info';
        var cls = rows[i].className || '';
        if (/error/i.test(cls) || /error/i.test(text.substring(0, 30))) type = 'error';
        else if (/compil/i.test(text.substring(0, 40))) type = 'compile';
        else if (/warn/i.test(cls)) type = 'warning';
        results.push({ timestamp: ts, type: type, message: text });
      }
      return results;
    })()
  `);

  return { success: true, entries: entries || [], entry_count: entries?.length || 0 };
}

export async function smartCompile({ _deps } = {}) {
  const d = _resolve(_deps);
  const { evaluate } = d;
  const editorReady = await ensurePineEditorOpen(_deps);
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const listBefore = await fetchScriptList(d.evaluateAsync);

  const studiesBefore = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const buttonClicked = await evaluate(`
    (function __clickCompileButton() {
      var btns = document.querySelectorAll('button');
      var addBtn = null;
      var updateBtn = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!addBtn && /^add to chart$/i.test(text)) addBtn = btns[i];
        if (!updateBtn && /^update on chart$/i.test(text)) updateBtn = btns[i];
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) saveBtn = btns[i];
      }
      if (addBtn) { addBtn.click(); return 'Add to chart'; }
      if (updateBtn) { updateBtn.click(); return 'Update on chart'; }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  if (!buttonClicked) {
    const c = await d.getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await d.sleep(2500);

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  const studiesAfter = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const studyAdded = (studiesBefore !== null && studiesAfter !== null) ? studiesAfter > studiesBefore : null;

  // "Add to chart" alone does not save; anything else (Pine Save, Save and
  // add to chart, Update on chart) may have written a script slot.
  const savedLikely = !/^add to chart$/i.test(buttonClicked || '');
  const { saved_to, note } = await resolveSaveTarget(d, listBefore, { polls: savedLikely ? 6 : 1 });

  return applySaveTracking({
    success: true,
    button_clicked: buttonClicked || 'keyboard_shortcut',
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
  }, saved_to, note);
}

/**
 * Creates a real new saved script slot by driving TradingView's own
 * "Open → New blank indicator/strategy/library" menu and saving the fresh
 * buffer. Never writes into the currently open buffer: a plain setValue
 * would make the next save silently overwrite whatever saved script was
 * open in the editor.
 */
export async function newScript({ type = 'indicator', name, _deps } = {}) {
  const d = _resolve(_deps);
  const validTypes = ['indicator', 'strategy', 'library'];
  if (!validTypes.includes(type)) {
    throw new Error(`Unknown script type "${type}". Valid types: ${validTypes.join(', ')}.`);
  }

  const editorReady = await ensurePineEditorOpen(_deps);
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const before = await fetchScriptList(d.evaluateAsync);
  if (!before.scripts) {
    throw new Error(`Could not read the saved-script list before creating (${before.error}). Aborting so no existing script can be overwritten.`);
  }

  // The Pine editor's script menu lives behind the script-title button
  // ("nameButton", aria-haspopup="menu"): title → "Create new" → type.
  const menu = await d.evaluate(`
    (function __openScriptTitleMenu() {
      var btn = document.querySelector('[class*="nameButton"][aria-haspopup]');
      if (!btn || btn.offsetParent === null) return { clicked: false };
      var label = (btn.textContent || '').trim();
      // clicking while expanded would close the menu instead of opening it
      if (btn.getAttribute('aria-expanded') === 'true') {
        return { clicked: true, label: label, already_open: true };
      }
      btn.click();
      return { clicked: true, label: label };
    })()
  `);
  if (!menu?.clicked) {
    throw new Error('Could not find the Pine editor script title menu button. pine_new must create a real script slot via that menu — refusing to overwrite the open buffer instead.');
  }
  await d.sleep(400);

  const createNew = await d.evaluate(`
    (function __clickCreateNewMenuItem() {
      var els = document.querySelectorAll('[role="menuitem"]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.offsetParent === null) continue;
        if (/^create new/i.test((el.textContent || '').trim())) {
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          el.click();
          return { clicked: true };
        }
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { clicked: false };
    })()
  `);
  if (!createNew?.clicked) {
    throw new Error('Could not find the "Create new" item in the Pine editor script menu. No script was created.');
  }
  await d.sleep(400);

  // Submenu items read e.g. "IndicatorCtrl + K, Ctrl + I" — match on prefix,
  // which also keeps "Built-in…" out.
  const item = await d.evaluate(`
    (function __clickNewScriptMenuItem() {
      var type = ${JSON.stringify(type)};
      var els = document.querySelectorAll('[role="menuitem"]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.offsetParent === null) continue;
        var text = (el.textContent || '').trim().toLowerCase();
        if (text.indexOf(type) === 0) {
          el.click();
          return { clicked: true, label: (el.textContent || '').trim() };
        }
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { clicked: false };
    })()
  `);
  if (!item?.clicked) {
    throw new Error(`Could not find the "${type}" menu item under "Create new". No script was created.`);
  }
  await d.sleep(600);

  // TradingView may ask about unsaved changes in the previous buffer.
  // Never click "Save" here — that would write into the previous slot.
  const dialog = await pollForDialog(d);
  if (dialog.handled) await d.sleep(400);

  // Save the fresh buffer so TradingView allocates a new script slot.
  // Ctrl+S is focus-dependent (chart focus saves the layout instead), so
  // click the editor's own save button.
  const saveBtn = await d.evaluate(`
    (function __clickEditorSaveButton() {
      var monaco = document.querySelector('.monaco-editor.pine-editor-monaco');
      var root = monaco;
      for (var i = 0; i < 25 && root; i++) {
        if (/editorBaseLayout/i.test((root.className || '').toString())) break;
        root = root.parentElement;
      }
      if (!root) root = document;
      var btn = root.querySelector('button[class*="saveButton"]');
      if (!btn || btn.offsetParent === null) return { clicked: false };
      btn.click();
      return { clicked: true, label: (btn.textContent || '').trim() };
    })()
  `);
  if (!saveBtn?.clicked) {
    throw new Error('Could not find the Pine editor save button to save the new script. The fresh buffer is open but unsaved; no existing script was touched.');
  }

  // The "Save script" name dialog renders asynchronously after the click.
  // Poll until it appears, then fill the name and confirm.
  let dialogHandled = false;
  for (let i = 0; i < 12; i++) {
    await d.sleep(400);
    const res = await d.evaluate(saveNameDialogExpr(name));
    if (res?.handled) { dialogHandled = true; break; }
  }
  if (!dialogHandled) {
    throw new Error('Saved the new script but the name dialog never appeared to confirm. The fresh buffer is open but may be unsaved; no existing script was touched.');
  }

  const beforeIds = new Set(before.scripts.map(s => s.id));
  let created = null;
  let after = null;
  for (let i = 0; i < 10; i++) {
    await d.sleep(700);
    after = await fetchScriptList(d.evaluateAsync);
    if (after.scripts) {
      created = after.scripts.find(s => !beforeIds.has(s.id)) || null;
      if (created) break;
    }
  }
  if (!created) {
    throw new Error('The UI flow completed but no new script slot appeared in the saved-script list. Nothing was created; existing scripts are untouched.');
  }

  _trackedOpenScript = { id: created.id, name: created.name };
  return {
    success: true,
    created: true,
    type,
    script: { id: created.id, name: created.name },
    scripts_count: after.scripts.length,
  };
}

export async function openScript({ name, _deps }) {
  const { evaluateAsync } = _resolve(_deps);
  const editorReady = await ensurePineEditorOpen(_deps);
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const escapedName = JSON.stringify(name.toLowerCase());

  const result = await evaluateAsync(`
    (function() {
      var target = ${escapedName};
      return fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(scripts) {
          if (!Array.isArray(scripts)) return {error: 'pine-facade returned unexpected data'};
          var match = null;
          for (var i = 0; i < scripts.length; i++) {
            var sn = (scripts[i].scriptName || '').toLowerCase();
            var st = (scripts[i].scriptTitle || '').toLowerCase();
            if (sn === target || st === target) { match = scripts[i]; break; }
          }
          if (!match) {
            for (var j = 0; j < scripts.length; j++) {
              var sn2 = (scripts[j].scriptName || '').toLowerCase();
              var st2 = (scripts[j].scriptTitle || '').toLowerCase();
              if (sn2.indexOf(target) !== -1 || st2.indexOf(target) !== -1) { match = scripts[j]; break; }
            }
          }
          if (!match) return {error: 'Script "' + target + '" not found. Use pine_list_scripts to see available scripts.'};

          var id = match.scriptIdPart;
          var ver = match.version || 1;
          return fetch('https://pine-facade.tradingview.com/pine-facade/get/' + id + '/' + ver, { credentials: 'include' })
            .then(function(r2) { return r2.json(); })
            .then(function(data) {
              var source = data.source || '';
              if (!source) return {error: 'Script source is empty', name: match.scriptName || match.scriptTitle};
              var m = ${FIND_MONACO};
              if (m) {
                m.editor.setValue(source);
                return {success: true, name: match.scriptName || match.scriptTitle, id: id, lines: source.split('\\n').length};
              }
              return {error: 'Monaco editor not found to inject source', name: match.scriptName || match.scriptTitle};
            });
        })
        .catch(function(e) { return {error: e.message}; });
    })()
  `);

  if (result?.error) {
    throw new Error(result.error);
  }

  // Note: this loads the script's source into the open buffer; TradingView
  // still considers the previously open slot active. The tracker lets the
  // save paths warn when a save lands in a different slot than expected.
  _trackedOpenScript = { id: result.id, name: result.name };

  return { success: true, name: result.name, script_id: result.id, lines: result.lines, source: 'internal_api', opened: true };
}

export async function listScripts({ _deps } = {}) {
  const { evaluateAsync } = _resolve(_deps);
  const { scripts, error } = await fetchScriptList(evaluateAsync);

  return {
    success: true,
    scripts: scripts || [],
    count: scripts?.length || 0,
    source: 'internal_api',
    error,
  };
}
