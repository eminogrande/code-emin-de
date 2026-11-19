import test from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from './clamp.mjs';

test('clamps value below min', () => assert.equal(clamp(-5, 0, 10), 0));
test('clamps value above max', () => assert.equal(clamp(20, 0, 10), 10));
test('keeps value in range', () => assert.equal(clamp(5, 0, 10), 5));
test('boundaries', () => {
  assert.equal(clamp(0, 0, 10), 0);
  assert.equal(clamp(10, 0, 10), 10);
});
