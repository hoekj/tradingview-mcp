import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickScreenMatch, deriveComplete } from '../src/core/screener.js';

const ROWS = [
  { name: 'Pre-market most active', section: 'MY SCREENS' },
  { name: 'Cam Prefilter', section: 'MY SCREENS' },
  { name: 'Most active', section: 'MY SCREENS' },
  { name: 'All stocks', section: 'POPULAR SCREENS' },
  { name: 'Most active', section: 'POPULAR SCREENS' },
];

describe('pickScreenMatch()', () => {
  it('matches a unique name exactly', () => {
    const res = pickScreenMatch(ROWS, 'Cam Prefilter');
    assert.equal(res.status, 'ok');
    assert.equal(res.match.name, 'Cam Prefilter');
    assert.equal(res.match.section, 'MY SCREENS');
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    const res = pickScreenMatch(ROWS, '  cam prefilter  ');
    assert.equal(res.status, 'ok');
    assert.equal(res.match.name, 'Cam Prefilter');
  });

  it('reports ambiguity when the name appears in both sections', () => {
    const res = pickScreenMatch(ROWS, 'Most active');
    assert.equal(res.status, 'ambiguous');
    assert.equal(res.matches.length, 2);
    assert.deepEqual(res.matches.map(m => m.section), ['MY SCREENS', 'POPULAR SCREENS']);
  });

  it('reports not_found with the full available list', () => {
    const res = pickScreenMatch(ROWS, '__no_such_screen__');
    assert.equal(res.status, 'not_found');
    assert.equal(res.available.length, ROWS.length);
  });

  it('never matches on a substring', () => {
    // "Most" is a prefix of two entries but is not an exact name.
    const res = pickScreenMatch(ROWS, 'Most');
    assert.equal(res.status, 'not_found');
  });
});

describe('deriveComplete()', () => {
  it('is complete when the list does not overflow its scroller', () => {
    assert.equal(deriveComplete({ scrollHeight: 378, clientHeight: 378 }), true);
  });

  it('is incomplete when the list overflows', () => {
    assert.equal(deriveComplete({ scrollHeight: 900, clientHeight: 378 }), false);
  });

  it('tolerates sub-pixel rounding up to 4px', () => {
    assert.equal(deriveComplete({ scrollHeight: 380, clientHeight: 378 }), true);
  });

  it('is not complete when the measurement is unavailable', () => {
    // Never claim completeness we could not observe.
    assert.equal(deriveComplete({ scrollHeight: null, clientHeight: null }), false);
  });
});
