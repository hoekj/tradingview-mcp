/**
 * Regression tests for the multi-Monaco editor break.
 *
 * A TradingView update made the Pine editor keep several Monaco instances
 * alive at once (one per recently opened script). The old finder took
 * getEditors()[0], which was frequently a hidden, read-only instance:
 *   - set_source wrote into the wrong buffer (nothing appeared on screen)
 *   - the visible editor never went dirty, so Ctrl+S/save persisted nothing
 *
 * On top of that, editor.setValue() fires an isFlush change that TradingView's
 * dirty tracking ignores, so even on the right editor the buffer stayed clean.
 * The fix selects the visible+writable editor and edits via executeEdits().
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickPineEditor, setSource } from '../src/core/pine.js';

// ── Editor mock ──────────────────────────────────────────────────────────

/**
 * Builds a Monaco-editor-like stub. `visible` controls whether getDomNode()
 * reports client rects; `readOnly` controls getRawOptions().readOnly.
 */
function editorStub({ id, visible = true, readOnly = false }) {
  return {
    id,
    getRawOptions() { return { readOnly }; },
    getDomNode() {
      return { getClientRects() { return visible ? [{ width: 100, height: 20 }] : []; } };
    },
  };
}

describe('pickPineEditor()', () => {
  it('skips a hidden read-only editor at index 0 and picks the visible writable one', () => {
    const editors = [
      editorStub({ id: 'hidden-ro', visible: false, readOnly: true }),
      editorStub({ id: 'bg-writable', visible: false, readOnly: false }),
      editorStub({ id: 'active', visible: true, readOnly: false }),
    ];
    assert.equal(pickPineEditor(editors).id, 'active');
  });

  it('prefers visible+writable over an earlier writable-but-hidden editor', () => {
    const editors = [
      editorStub({ id: 'bg', visible: false, readOnly: false }),
      editorStub({ id: 'active', visible: true, readOnly: false }),
    ];
    assert.equal(pickPineEditor(editors).id, 'active');
  });

  it('falls back to the first writable editor when none are visible', () => {
    const editors = [
      editorStub({ id: 'ro', visible: false, readOnly: true }),
      editorStub({ id: 'first-writable', visible: false, readOnly: false }),
      editorStub({ id: 'second-writable', visible: false, readOnly: false }),
    ];
    assert.equal(pickPineEditor(editors).id, 'first-writable');
  });

  it('falls back to editors[0] when nothing is writable', () => {
    const editors = [
      editorStub({ id: 'a', visible: false, readOnly: true }),
      editorStub({ id: 'b', visible: true, readOnly: true }),
    ];
    assert.equal(pickPineEditor(editors).id, 'a');
  });

  it('treats a throwing getRawOptions() as writable (never wedges on API drift)', () => {
    const broken = { getRawOptions() { throw new Error('nope'); }, getDomNode() { return { getClientRects() { return [{}]; } }; } };
    assert.equal(pickPineEditor([broken]), broken);
  });
});

describe('setSource() dirties the buffer via executeEdits', () => {
  it('injects executeEdits (not setValue) so TradingView marks the buffer dirty', async () => {
    const exprs = [];
    const evaluate = async (expr) => {
      exprs.push(expr);
      if (expr.includes('findMonacoEditor')) { return true; }   // editor ready
      if (expr.includes('executeEdits')) { return true; }       // set succeeded
      if (expr.includes('__readOpenScriptName')) { return 'Fresh script'; }
      return undefined;
    };
    const result = await setSource({ source: 'plot(close)', _deps: { evaluate, sleep: async () => {} } });

    assert.equal(result.success, true);
    const setExpr = exprs.find(e => e.includes('getFullModelRange'));
    assert.ok(setExpr, 'setSource should inject an editor-mutation expression');
    assert.match(setExpr, /executeEdits/, 'must use executeEdits so the dirty flag flips');
    assert.doesNotMatch(setExpr, /\.setValue\(/, 'must not use setValue (its flush change is ignored by TV dirty tracking)');
  });
});
