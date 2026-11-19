import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from './slug.mjs';

test('basic', () => assert.equal(slugify('Hello World'), 'hello-world'));
test('collapse', () => assert.equal(slugify('a --  b'), 'a-b'));
test('trim', () => assert.equal(slugify('--X--'), 'x'));
test('non-alnum only', () => assert.equal(slugify('!!!'), ''));
