'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stableFileName } = require('../src/har-archive');

test('stableFileName is deterministic and URL-specific', () => {
  const first = stableFileName(
    'https://games.example.com/a?demo=1',
    0
  );

  const again = stableFileName(
    'https://games.example.com/a?demo=1',
    0
  );

  const other = stableFileName(
    'https://games.example.com/b?demo=1',
    1
  );

  assert.equal(first, again);
  assert.notEqual(first, other);
  assert.match(first, /^00001_games\.example\.com_[0-9a-f]{10}\.har$/);
});

test('stableFileName survives invalid URLs', () => {
  assert.match(
    stableFileName('not a url', 9),
    /^00010_target_[0-9a-f]{10}\.har$/
  );
});
