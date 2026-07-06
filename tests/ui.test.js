import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { layoutSwitch } from '../src/core/ui.js';

const PRE_MARKET = { url: '7sSXjUUP', id: '190561459', name: 'Pre-market scan' };

// Build injected deps modelling the live chart:
//  - evaluateAsync resolves the saved-chart lookup to `match`
//  - evaluate answers layoutName() reads via `currentLayout()`
//  - navigate records the URL it was asked to open
function makeDeps({ match = PRE_MARKET, currentLayout }) {
  const navigations = [];
  const deps = {
    evaluateAsync: async () => match,
    evaluate: async (expr) => (String(expr).includes('layoutName') ? currentLayout() : null),
    navigate: async (url) => { navigations.push(url); },
    sleep: async () => {},
  };
  return { deps, navigations };
}

describe('layoutSwitch()', () => {
  it('navigates to the layout slug and reports verified success once the switch lands', async () => {
    let landed = false;
    const { deps, navigations } = makeDeps({ currentLayout: () => (landed ? 'Pre-market scan' : 'BaseTemplate') });
    // Model the real switch: the active layout only changes after navigation.
    const recordNav = deps.navigate;
    deps.navigate = async (url) => { landed = true; return recordNav(url); };

    const result = await layoutSwitch({ name: 'Pre-market scan', _deps: deps });

    assert.equal(result.success, true);
    assert.equal(result.verified, true);
    assert.equal(result.layout, 'Pre-market scan');
    assert.equal(result.layout_id, '7sSXjUUP');
    assert.deepEqual(navigations, ['https://www.tradingview.com/chart/7sSXjUUP/']);
  });

  it('throws instead of reporting success when the active layout never changes', async () => {
    // Navigation is issued but the layout stays put — exactly the failure the
    // old code masked by returning success:true from a fire-and-forget load.
    const { deps, navigations } = makeDeps({ currentLayout: () => 'BaseTemplate' });

    await assert.rejects(
      () => layoutSwitch({ name: 'Pre-market scan', _deps: deps }),
      /did not load/i
    );
    assert.equal(navigations.length, 1, 'navigation was attempted before failing');
  });

  it('throws a clear error when the requested layout does not exist', async () => {
    const { deps, navigations } = makeDeps({ match: null, currentLayout: () => 'BaseTemplate' });

    await assert.rejects(
      () => layoutSwitch({ name: 'Does Not Exist', _deps: deps }),
      /not found/i
    );
    assert.equal(navigations.length, 0, 'no navigation attempted for an unknown layout');
  });
});
