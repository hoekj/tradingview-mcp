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
