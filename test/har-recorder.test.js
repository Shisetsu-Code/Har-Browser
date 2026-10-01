'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  headersToArray,
  queryString,
  normalizeHttpVersion,
  normalizeResourceType,
  uploadDataToText,
  isGameOnlyEntry,
  isBodylessResponse,
  bodyCaptureLimit,
  mergeEntry
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


test('normalizes Electron webRequest resource types', () => {
  assert.equal(normalizeResourceType('xhr'), 'XHR');
  assert.equal(normalizeResourceType('webSocket'), 'WebSocket');
  assert.equal(normalizeResourceType('subFrame'), 'Document');
});

test('extracts raw POST bytes from Electron uploadData', () => {
  assert.equal(
    uploadDataToText([{ bytes: Buffer.from('command=spin&bet=1') }]),
    'command=spin&bet=1'
  );
});


test('GAME ONLY keeps protocol traffic and removes assets/preflight', () => {
  assert.equal(isGameOnlyEntry({
    __resourceType: 'XHR',
    request: { method: 'GET', url: 'https://game.test/api/state' }
  }), true);

  assert.equal(isGameOnlyEntry({
    __resourceType: 'Image',
    request: { method: 'GET', url: 'https://game.test/assets/reel.webp' }
  }), false);

  assert.equal(isGameOnlyEntry({
    __resourceType: 'Other',
    request: { method: 'POST', url: 'https://game.test/api/spin' }
  }), true);

  assert.equal(isGameOnlyEntry({
    __resourceType: 'XHR',
    request: { method: 'OPTIONS', url: 'https://game.test/api/spin' }
  }), false);

  assert.equal(isGameOnlyEntry({
    __resourceType: 'Media',
    request: { method: 'GET', url: 'blob:https://game.test/audio-id' }
  }), false);
});


test('protocol responses get the larger body capture budget', () => {
  const entry = {
    __resourceType: 'XHR',
    request: {
      method: 'POST',
      url: 'https://game.test/api/spin'
    },
    response: { status: 200 }
  };

  assert.equal(
    bodyCaptureLimit(
      entry,
      true,
      32 * 1024 * 1024,
      64 * 1024 * 1024
    ),
    64 * 1024 * 1024
  );
});

test('bodyless HTTP responses are not treated as missing bodies', () => {
  assert.equal(
    isBodylessResponse({
      request: { method: 'POST' },
      response: { status: 204 }
    }),
    true
  );

  assert.equal(
    isBodylessResponse({
      request: { method: 'POST' },
      response: { status: 200 }
    }),
    false
  );
});

test('CDP response body survives merge with webRequest metadata', () => {
  const base = {
    startedDateTime: new Date().toISOString(),
    time: 1,
    request: {
      method: 'POST',
      url: 'https://game.test/api/spin',
      headers: [],
      bodySize: 12,
      postData: {
        mimeType: 'application/json',
        text: '{"bet":1}'
      }
    },
    response: {
      status: 200,
      headers: [],
      bodySize: 25,
      content: {
        size: 25,
        mimeType: 'application/json',
        _bodyCaptureStatus: 'awaiting-cdp-merge'
      }
    },
    timings: {}
  };

  const richer = {
    ...base,
    response: {
      ...base.response,
      content: {
        size: 25,
        mimeType: 'application/json',
        text: '{"win":5,"balance":105}',
        _bodyCaptureStatus: 'captured'
      }
    }
  };

  const merged = mergeEntry(base, richer);

  assert.equal(
    merged.response.content.text,
    '{"win":5,"balance":105}'
  );

  assert.equal(
    merged.response.content._bodyCaptureStatus,
    'captured'
  );
});


test('merge preserves body capture failure diagnostics from CDP', () => {
  const base = {
    request: {
      method: 'POST',
      url: 'https://game.test/api/spin',
      headers: []
    },
    response: {
      status: 200,
      headers: [],
      content: {
        mimeType: 'application/json',
        _bodyCaptureStatus: 'awaiting-cdp-merge'
      }
    },
    timings: {},
    time: 0
  };

  const richer = {
    ...base,
    response: {
      ...base.response,
      content: {
        mimeType: 'application/json',
        _bodyCaptureStatus: 'unavailable',
        _bodyCaptureError: 'No resource with given identifier found'
      }
    }
  };

  const merged = mergeEntry(base, richer);

  assert.equal(
    merged.response.content._bodyCaptureStatus,
    'unavailable'
  );

  assert.equal(
    merged.response.content._bodyCaptureError,
    'No resource with given identifier found'
  );
});


test('root CDP commands omit the session id argument', async () => {
  const calls = [];
  const fakeWebContents = {
    debugger: {
      sendCommand(...args) {
        calls.push(args);
        return Promise.resolve({ ok: true });
      }
    }
  };

  const recorder = new (require('../src/har-recorder').HarRecorder)(
    fakeWebContents
  );

  await recorder._sendCommand(
    'Network.getResponseBody',
    { requestId: '123' },
    undefined
  );

  await recorder._sendCommand(
    'Network.getResponseBody',
    { requestId: '456' },
    ''
  );

  await recorder._sendCommand(
    'Network.getResponseBody',
    { requestId: '789' },
    'child-session'
  );

  assert.equal(calls[0].length, 2);
  assert.equal(calls[1].length, 2);
  assert.equal(calls[2].length, 3);
  assert.equal(calls[2][2], 'child-session');
});
