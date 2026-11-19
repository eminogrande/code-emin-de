import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from './slug.mjs';

test('normal phrase', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('leading/trailing punctuation trimmed', () => {
  assert.equal(slugify('  !!!Hello World???  '), 'hello-world');
});

test('multiple consecutive symbols collapse to one dash', () => {
  assert.equal(slugify('a___b   c---d'), 'a-b-c-d');
});

test('uppercase lowered', () => {
  assert.equal(slugify('ABC Def'), 'abc-def');
});

test('empty string', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify('!!!'), '');
});
