import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { layoutSwitch } from '../src/core/ui.js';

describe('layoutSwitch()', () => {
  it('calls pollForDialog after switching layout', async () => {
    const calls = [];
    const _deps = {
      evaluate: async (expr) => {
        calls.push(expr);
        return undefined;
      },
      evaluateAsync: async () => ({ success: true, method: 'loadChartFromServer', id: '42', name: 'My Layout', source: 'internal_api' }),
      sleep: async () => {},
    };
    const result = await layoutSwitch({ name: 'My Layout', _deps });
    assert.equal(result.success, true);
    assert.ok(
      calls.some(c => c.includes('__dismissDialog')),
      'expected pollForDialog evaluate call after layout switch'
    );
  });
});
