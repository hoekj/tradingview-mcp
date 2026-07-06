// tests/tools.e2e.test.js
//
// Drives the MCP TOOL layer (src/tools/*.js) instead of src/core directly.
// This closes a real coverage gap: the *.core.test.js suites import
// src/core and would miss a bug in the tool-adapter layer (e.g. a tool
// wired to the wrong core fn, bad param passing, or a stale ReferenceError
// that only surfaces through the registered handler).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { teardown } from './helpers/live.js';

import { registerHealthTools } from '../src/tools/health.js';
import { registerChartTools } from '../src/tools/chart.js';
import { registerDataTools } from '../src/tools/data.js';
import { registerDrawingTools } from '../src/tools/drawing.js';
import { registerPineTools } from '../src/tools/pine.js';
import { registerWatchlistTools } from '../src/tools/watchlist.js';
import { registerUiTools } from '../src/tools/ui.js';

// Build a fake MCP server that just captures each tool's handler function,
// exactly the way the real server registration works (server.tool(name, desc, schema, handler)).
function buildHandlers() {
  const handlers = {};
  const server = { tool: (name, _desc, _schema, fn) => { handlers[name] = fn; } };
  registerHealthTools(server);
  registerChartTools(server);
  registerDataTools(server);
  registerDrawingTools(server);
  registerPineTools(server);
  registerWatchlistTools(server);
  registerUiTools(server);
  return handlers;
}

// Call a registered handler and unwrap the MCP envelope back to a plain object.
async function call(handlers, name, args = {}) {
  if (!handlers[name]) {
    throw new Error(`No handler registered for tool: ${name}`);
  }
  const res = await handlers[name](args);
  const data = JSON.parse(res.content[0].text);
  return { data, isError: !!res.isError };
}

describe('MCP tool layer (live e2e)', () => {
  const handlers = buildHandlers();

  // Safety guard, same pattern as tests/drawing.core.test.js: never mutate
  // drawings on a chart that already has user shapes on it.
  let preExistingCount = null;

  before(async () => {
    const { data } = await call(handlers, 'draw_list');
    preExistingCount = data.count;
  });

  after(async () => {
    await teardown();
  });

  it('tv_health_check reports success through the tool handler', async () => {
    const { data, isError } = await call(handlers, 'tv_health_check');
    assert.equal(isError, false);
    assert.equal(data.success, true);
  });

  it('chart_get_state reports success through the tool handler', async () => {
    const { data, isError } = await call(handlers, 'chart_get_state');
    assert.equal(isError, false);
    assert.equal(data.success, true);
  });

  it('quote_get reports success through the tool handler', async () => {
    const { data, isError } = await call(handlers, 'quote_get');
    assert.equal(isError, false);
    assert.equal(data.success, true);
  });

  it('data_get_ohlcv (summary) reports success through the tool handler', async () => {
    const { data, isError } = await call(handlers, 'data_get_ohlcv', { summary: true });
    assert.equal(isError, false);
    assert.equal(data.success, true);
  });

  it('data_get_study_values reports success through the tool handler', async () => {
    const { data, isError } = await call(handlers, 'data_get_study_values');
    assert.equal(isError, false);
    assert.equal(data.success, true);
  });

  // KEY REGRESSION TEST: draw_list must return success:true through the
  // registered tool handler. A stale adapter wiring / ReferenceError in the
  // tool layer (as distinct from src/core, which has its own passing test)
  // would only surface here, via the actual handler function the MCP server
  // would call.
  it('draw_list reports success through the tool handler (adapter regression guard)', async () => {
    const { data, isError } = await call(handlers, 'draw_list');
    assert.equal(isError, false);
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.shapes), 'shapes is an array');
  });

  it('pine_list_scripts reports success through the tool handler', async () => {
    const { data, isError } = await call(handlers, 'pine_list_scripts');
    assert.equal(isError, false);
    assert.equal(data.success, true);
  });

  it('watchlist_get reports success through the tool handler', async () => {
    const { data, isError } = await call(handlers, 'watchlist_get');
    assert.equal(isError, false);
    assert.equal(data.success, true);
  });

  it('draw_shape -> draw_list -> draw_remove_one round-trip through the tool handlers', async (t) => {
    if (preExistingCount > 0) {
      t.skip(`chart already has ${preExistingCount} drawing(s); skipping destructive test to avoid clobbering user drawings`);
      return;
    }

    const ohlcv = await call(handlers, 'data_get_ohlcv', { count: 5 });
    assert.equal(ohlcv.isError, false);
    const bars = ohlcv.data.bars;
    const last = bars[bars.length - 1];

    const created = await call(handlers, 'draw_shape', {
      shape: 'horizontal_line',
      point: { time: last.time, price: last.close },
    });
    assert.equal(created.isError, false);
    assert.equal(created.data.success, true);
    assert.ok(created.data.entity_id, 'shape created with an entity id');

    const list = await call(handlers, 'draw_list');
    assert.equal(list.isError, false);
    assert.equal(list.data.success, true);
    assert.ok(
      list.data.shapes.some((s) => s.id === created.data.entity_id),
      'newly created shape is present in draw_list output'
    );

    const removed = await call(handlers, 'draw_remove_one', { entity_id: created.data.entity_id });
    assert.equal(removed.isError, false);
    assert.equal(removed.data.success, true);
    assert.equal(removed.data.removed, true);

    // Confirm the chart is left exactly as we found it (empty).
    const finalList = await call(handlers, 'draw_list');
    assert.equal(finalList.data.count, 0, 'chart has no leftover drawings after cleanup');
  });
});

// Regression coverage for the layout_switch defect: the tool used to report
// success:true from a fire-and-forget loadChartFromServer that never actually
// changed the active layout. These tests drive the real handler and then read
// the LIVE layout back independently, so a switch that silently no-ops fails.
describe('layout_switch (live e2e)', () => {
  const handlers = buildHandlers();
  let original = null;

  // Read the active layout name + unsaved-changes flag straight from the page.
  async function readLayout() {
    const { data } = await call(handlers, 'ui_evaluate', {
      expression:
        `(function(){try{var a=window.TradingViewApi;` +
        `var ss=a.getSaveChartService?a.getSaveChartService():a._saveChartService;` +
        `return {name:String(a.layoutName()),dirty:ss.hasChanges()};}` +
        `catch(e){return {err:e.message};}})()`,
    });
    return data.result || {};
  }

  after(async () => {
    // Best-effort: return to whatever layout we started on.
    if (original && original.name) {
      try { await call(handlers, 'layout_switch', { name: original.name }); } catch { /* ignore */ }
    }
    await teardown();
  });

  it('switches layout and verifies the active layout actually changed', { timeout: 120000 }, async (t) => {
    const list = await call(handlers, 'layout_list');
    const layouts = list.data.layouts || [];
    if (layouts.length < 2) {
      t.skip('need >= 2 saved layouts to exercise a switch');
      return;
    }

    const start = await readLayout();
    original = original || start;
    const target = layouts.find((l) => l.name && l.name.toLowerCase() !== String(start.name).toLowerCase());
    assert.ok(target, 'a layout different from the current one exists');

    const res = await call(handlers, 'layout_switch', { name: target.name });
    assert.equal(res.isError, false);
    assert.equal(res.data.success, true);
    assert.equal(res.data.verified, true, 'tool claims the switch was verified');

    // Independent readback — the assertion that fails against the old code.
    const after = await readLayout();
    assert.equal(
      String(after.name).toLowerCase(),
      String(target.name).toLowerCase(),
      'active layout reflects the requested switch'
    );
  });

  it('switches away from a DIRTY layout, discarding the unsaved changes', { timeout: 120000 }, async (t) => {
    const list = await call(handlers, 'layout_list');
    const layouts = list.data.layouts || [];
    if (layouts.length < 2) {
      t.skip('need >= 2 saved layouts to exercise a switch');
      return;
    }

    const start = await readLayout();
    original = original || start;

    // Dirty the current layout by changing its symbol without saving.
    const dirtied = await call(handlers, 'ui_evaluate', {
      expression:
        `(function(){var c=window.TradingViewApi.activeChart();` +
        `c.setSymbol(c.symbol()==='NASDAQ:AAPL'?'NASDAQ:MSFT':'NASDAQ:AAPL');` +
        `var a=window.TradingViewApi;var ss=a.getSaveChartService?a.getSaveChartService():a._saveChartService;` +
        `return {dirty:ss.hasChanges(),name:String(a.layoutName())};})()`,
    });
    assert.equal(dirtied.data.result.dirty, true, 'chart is dirty before switching');

    const current = String(dirtied.data.result.name).toLowerCase();
    const target = layouts.find((l) => l.name && l.name.toLowerCase() !== current);
    assert.ok(target, 'a layout different from the current one exists');

    const res = await call(handlers, 'layout_switch', { name: target.name });
    assert.equal(res.isError, false, JSON.stringify(res.data));
    assert.equal(res.data.success, true);
    assert.equal(res.data.verified, true);

    const after = await readLayout();
    assert.equal(
      String(after.name).toLowerCase(),
      String(target.name).toLowerCase(),
      'switched to the target layout despite pending changes'
    );
    assert.equal(after.dirty, false, 'the unsaved changes were discarded by the switch');
  });
});
