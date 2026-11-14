import assert from 'node:assert/strict';
import { test } from 'node:test';

import { greet } from '../src/greet.js';

test('greet addresses the caller by name', () => {
  assert.equal(greet('world'), 'Hello, world!');
});

test('greet falls back to a default', () => {
  assert.equal(greet('there'), 'Hello, there!');
});
