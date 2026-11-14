import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCount } from '../src/parse.js';

test('parseCount reads a decimal string', () => {
  assert.equal(parseCount('42'), 42);
});

test('parseCount ignores surrounding whitespace', () => {
  assert.equal(parseCount(' 7 '), 7);
});
