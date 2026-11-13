import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sum } from '../src/sum.js';

// Three assertions, all of which fail against the shipped implementation. The file
// itself is correct and must not be edited: the point of the exercise is that the
// agent fixes the source, not the expectations.
test('sum adds two positive numbers', () => {
  assert.equal(sum(2, 3), 5);
});

test('sum adds a larger pair', () => {
  assert.equal(sum(7, 2), 9);
});

test('sum adds two negative numbers', () => {
  assert.equal(sum(-1, -1), -2);
});
