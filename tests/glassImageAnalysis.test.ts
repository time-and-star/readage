import assert from 'node:assert/strict';
import test from 'node:test';
import { mapGlassDensityToWindow } from '../src/lib/glassImageAnalysis';

test('detail density follows the visible central crop rather than clipped-off picture edges', () => {
  const density = mapGlassDensityToWindow({ columns: 4, rows: 1, values: [.1, .3, .7, .9] },
    1200, 400, 300, 400, 'cover', .5, .5);
  assert.deepEqual(new Set(density.values), new Set([.3, .7]));
  assert.ok(density.values.slice(0, density.columns / 2).every(value => value === .3));
  assert.ok(density.values.slice(density.columns / 2, density.columns).every(value => value === .7));
});

test('letterboxed paper stays sparse while all visible photographic detail is retained', () => {
  const density = mapGlassDensityToWindow({ columns: 1, rows: 1, values: [1] },
    600, 300, 300, 300, 'contain', .5, .5);
  const row = (index: number) => density.values.slice(index * density.columns, (index + 1) * density.columns);
  assert.ok(row(0).every(value => value === 0));
  assert.ok(row(7).every(value => value === 0));
  assert.ok(row(8).every(value => value === 1));
  assert.ok(row(23).every(value => value === 1));
  assert.ok(row(24).every(value => value === 0));
  assert.ok(row(31).every(value => value === 0));
});
