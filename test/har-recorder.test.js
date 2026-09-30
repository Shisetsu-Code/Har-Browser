'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  headersToArray,
  queryString,
  normalizeHttpVersion
} = require('../src/har-recorder');

test('headersToArray converts CDP headers to HAR headers', () => {
  assert.deepEqual(headersToArray({ Accept: '*/*', 'X-Test': 7 }), [
    { name: 'Accept', value: '*/*' },
    { name: 'X-Test', value: '7' }
  ]);
});

test('queryString preserves repeated query parameters', () => {
  assert.deepEqual(queryString('https://example.com/spin?bet=1&bet=2&mode=demo'), [
    { name: 'bet', value: '1' },
    { name: 'bet', value: '2' },
    { name: 'mode', value: 'demo' }
  ]);
});

test('normalizeHttpVersion maps Chromium protocol names', () => {
  assert.equal(normalizeHttpVersion('h2'), 'HTTP/2');
  assert.equal(normalizeHttpVersion('h3'), 'HTTP/3');
  assert.equal(normalizeHttpVersion('http/1.1'), 'HTTP/1.1');
});
