import test from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from './clamp.mjs';

test('below min', () => assert.equal(clamp(-5, 0, 10), 0));
test('above max', () => assert.equal(clamp(15, 0, 10), 10));
test('in range', () => assert.equal(clamp(5, 0, 10), 5));
test('boundary equal values', () => {
  assert.equal(clamp(0, 0, 10), 0);
  assert.equal(clamp(10, 0, 10), 10);
});
test('swapped bounds', () => {
  assert.equal(clamp(-5, 10, 0), 0);
  assert.equal(clamp(15, 10, 0), 10);
  assert.equal(clamp(5, 10, 0), 5);
});
test('non-number throws', () => {
  assert.throws(() => clamp('1', 0, 10), TypeError);
  assert.throws(() => clamp(NaN, 0, 10), TypeError);
  assert.throws(() => clamp(Infinity, 0, 10), TypeError);
  assert.throws(() => clamp(null, 0, 10), TypeError);
});
