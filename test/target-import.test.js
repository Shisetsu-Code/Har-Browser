'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTargets } = require('../src/target-import');

test('parseTargets accepts URLs, bare hosts and ignores comments', () => {
  const targets = parseTargets(`
# provider A
https://example.com/game-one
example.org/game-two

// disabled
https://example.net/game-three
`);

  assert.deepEqual(targets, [
    'https://example.com/game-one',
    'https://example.org/game-two',
    'https://example.net/game-three'
  ]);
});

test('parseTargets extracts URLs from annotated lines and removes duplicates', () => {
  const targets = parseTargets(`
game 1 https://games.test/a
https://games.test/a
game 2: https://games.test/b?mode=demo
`);

  assert.deepEqual(targets, [
    'https://games.test/a',
    'https://games.test/b?mode=demo'
  ]);
});

test('parseTargets rejects unsupported protocols and invalid lines', () => {
  assert.deepEqual(
    parseTargets('ftp://example.com/a\nnot a valid url with spaces'),
    []
  );
});
