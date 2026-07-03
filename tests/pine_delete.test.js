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
