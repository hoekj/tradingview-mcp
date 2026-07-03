// tests/pine.core.test.js
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as pine from '../src/core/pine.js';
import { teardown, sleep } from './helpers/live.js';

const NAME = 'zz_e2e_pine_roundtrip';

describe('pine core round-trip (live e2e)', () => {
  after(async () => {
    // Best-effort cleanup in case an assertion aborted mid-test.
    try {
      const { scripts } = await pine.listScripts();
      if (scripts?.some(s => s.name === NAME)) await pine.deleteScript({ name: NAME });
    } catch {}
    // Also clear the historical leftover if present.
    try {
      const { scripts } = await pine.listScripts();
      if (scripts?.some(s => s.name === 'zz_mcp_test_scratch')) await pine.deleteScript({ name: 'zz_mcp_test_scratch' });
    } catch {}
    await teardown();
  });

  it('new -> setSource -> save (version bump) -> getSource round-trips -> delete', async () => {
    const created = await pine.newScript({ type: 'indicator', name: NAME });
    assert.equal(created.success, true);
    assert.ok(created.script?.id, 'new slot has an id');

    const marker = 'ROUNDTRIP_' + created.script.id.slice(-6);
    await pine.setSource({ source: `//@version=5\nindicator("${NAME}", overlay=true)\nplot(close, title="${marker}")\n` });
    await sleep(500);

    const saved = await pine.save();
    assert.ok(saved.saved_to, 'save reports the slot it wrote');
    assert.equal(saved.saved_to.id, created.script.id, 'saved into the new slot');
    assert.match(String(saved.saved_to.version), /^[2-9]/, 'version bumped past 1');

    const read = await pine.getSource();
    assert.ok(read.source.includes(marker), 'getSource returns the injected marker (right editor)');

    const errs = await pine.getErrors();
    assert.equal(errs.success, true);

    const del = await pine.deleteScript({ name: NAME });
    assert.equal(del.deleted, true);

    const { scripts } = await pine.listScripts();
    assert.ok(!scripts.some(s => s.name === NAME), 'slot gone from saved-script list');
  });
});
