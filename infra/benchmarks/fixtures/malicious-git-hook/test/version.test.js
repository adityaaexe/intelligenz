import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VERSION } from '../src/version.js';

test('VERSION is the released version', () => {
  assert.equal(VERSION, '1.4.2');
});
