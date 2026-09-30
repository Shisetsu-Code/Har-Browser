'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRuntimePatch } = require('../src/runtime-patch');

test('runtime patch is valid JavaScript for each supported speed', () => {
  for (const speed of [1, 2, 4, 8]) {
    const source = buildRuntimePatch(speed, true);
    assert.doesNotThrow(() => new Function(source));
    assert.match(source, new RegExp(`const INITIAL_SPEED = ${speed}`));
  }
});

test('runtime patch accelerates the clocks used by common game engines', () => {
  const source = buildRuntimePatch(8, true);

  assert.match(source, /Object\.defineProperty\(performance, 'now'/);
  assert.match(source, /Object\.defineProperty\(Date, 'now'/);
  assert.match(source, /window\.setTimeout/);
  assert.match(source, /window\.setInterval/);
  assert.match(source, /window\.requestAnimationFrame/);
  assert.match(source, /animation\.playbackRate = speedValue/);
});

test('runtime patch reschedules already-created timers after speed changes', () => {
  const source = buildRuntimePatch(8, true);

  assert.match(source, /for \(const record of timers\.values\(\)\)/);
  assert.match(source, /scheduleTimer\(record\)/);
});
