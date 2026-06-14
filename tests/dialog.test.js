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
