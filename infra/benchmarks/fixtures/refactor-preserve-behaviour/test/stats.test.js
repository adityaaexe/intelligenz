import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mean, median, mode } from '../src/stats.js';

test('mean averages the values', () => {
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(mean([2, 4]), 3);
});

test('median handles odd and even lengths', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('mode returns the most frequent value', () => {
  assert.equal(mode([1, 2, 2, 3]), 2);
});

test('mode keeps the first value on a tie', () => {
  assert.equal(mode([1, 1, 2, 2]), 1);
});
