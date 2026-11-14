import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_HOST, DEFAULT_PORT, describe as describeEndpoint } from '../src/config.js';

test('default port is a number', () => {
  assert.equal(typeof DEFAULT_PORT, 'number');
});

test('default port is 3100', () => {
  assert.equal(DEFAULT_PORT, 3100);
});

test('describe joins host and port', () => {
  assert.equal(describeEndpoint(), '0.0.0.0:3100');
});

test('host is unchanged', () => {
  assert.equal(DEFAULT_HOST, '0.0.0.0');
});
