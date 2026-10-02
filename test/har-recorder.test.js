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
  mergeEntry,
  parseWebSocketText,
  decodeWebSocketPayload,
  extractWebSocketCorrelation,
  classifyWebSocketGameEvent
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


test('decodes JSON WebSocket spin messages', () => {
  const decoded = decodeWebSocketPayload(
    JSON.stringify({
      command: 'spin',
      bet: 25,
      requestId: 'abc-123'
    }),
    1
  );

  assert.equal(decoded.format, 'json');
  assert.equal(decoded.parsed.command, 'spin');

  const event =
    classifyWebSocketGameEvent(
      decoded,
      'sent'
    );

  assert.equal(event.kind, 'spin');
  assert.equal(event.correlationId, 'abc-123');
});

test('decodes Socket.IO game events', () => {
  const decoded =
    parseWebSocketText(
      '42["spin",{"bet":10,"roundId":"r-7"}]'
    );

  assert.equal(decoded.format, 'socket.io');
  assert.equal(decoded.eventName, 'spin');
  assert.deepEqual(decoded.eventData, {
    bet: 10,
    roundId: 'r-7'
  });

  const correlation =
    extractWebSocketCorrelation(decoded);

  assert.deepEqual(correlation, {
    key: 'roundId',
    value: 'r-7'
  });

  const event =
    classifyWebSocketGameEvent(
      decoded,
      'sent'
    );

  assert.equal(event.kind, 'spin');
});

test('decodes binary WebSocket JSON carried as base64', () => {
  const raw =
    Buffer.from(
      '{"action":"buyFeature","transactionId":"tx-9"}',
      'utf8'
    ).toString('base64');

  const decoded =
    decodeWebSocketPayload(raw, 2);

  assert.equal(
    decoded.encoding,
    'base64->utf8'
  );

  assert.equal(
    decoded.parsed.transactionId,
    'tx-9'
  );

  const event =
    classifyWebSocketGameEvent(
      decoded,
      'sent'
    );

  assert.equal(
    event.kind,
    'buy-feature'
  );
});

test('opaque binary WebSocket payload stays preserved as base64', () => {
  const raw =
    Buffer.from([
      0x00,
      0xff,
      0x01,
      0xfe,
      0x02
    ]).toString('base64');

  const decoded =
    decodeWebSocketPayload(raw, 2);

  assert.equal(decoded.format, 'binary');
  assert.equal(decoded.base64, raw);
  assert.equal(decoded.byteLength, 5);
});


test('captures frames from a WebSocket opened before REC', () => {
  const fakeWebContents = {
    debugger: {
      sendCommand() {
        return Promise.resolve({});
      }
    },
    getTitle() {
      return 'WS game';
    },
    getURL() {
      return 'https://game.test';
    }
  };

  const recorder = new HarRecorder(
    fakeWebContents,
    {
      gameOnly: true,
      webSocketSnapshotProvider: () => [
        {
          key: 'root:ws-1',
          requestId: 'ws-1',
          sessionId: null,
          url: 'wss://game.test/socket',
          requestHeaders: {
            Origin: 'https://game.test'
          },
          responseHeaders: {
            Upgrade: 'websocket'
          },
          status: 101,
          statusText: 'Switching Protocols',
          closed: false
        }
      ]
    }
  );

  recorder.startedAt =
    new Date('2026-10-02T00:00:00.000Z');

  recorder.recording = true;
  recorder._seedExistingWebSockets();

  recorder._webSocketFrame(
    {
      requestId: 'ws-1',
      timestamp: 100,
      response: {
        opcode: 1,
        mask: true,
        payloadData:
          '{"command":"spin","requestId":"r1","bet":25}'
      }
    },
    'sent'
  );

  recorder._webSocketFrame(
    {
      requestId: 'ws-1',
      timestamp: 100.1,
      response: {
        opcode: 1,
        mask: false,
        payloadData:
          '{"requestId":"r1","win":50,"balance":1000}'
      }
    },
    'received'
  );

  const entry =
    recorder.active.get('root:ws-1');

  assert.ok(entry);
  assert.equal(
    entry.request.url,
    'wss://game.test/socket'
  );

  recorder._finalize(entry);

  const json = recorder.toJSON();

  assert.equal(json.log.entries.length, 1);
  assert.equal(
    json.log.entries[0]._webSocketFrames.length,
    2
  );

  assert.equal(
    json.log.entries[0]._webSocketTransactions.length,
    1
  );

  assert.equal(
    json.log.entries[0]._webSocketTransactions[0].kind,
    'spin'
  );
});

test('late WebSocket frame creates a synthetic HAR entry', () => {
  const fakeWebContents = {
    debugger: {
      sendCommand() {
        return Promise.resolve({});
      }
    },
    getTitle() {
      return 'Late WS';
    },
    getURL() {
      return 'https://game.test';
    }
  };

  const recorder = new HarRecorder(
    fakeWebContents,
    { gameOnly: true }
  );

  recorder.startedAt = new Date();
  recorder.recording = true;

  recorder._webSocketFrame(
    {
      requestId: 'unknown-ws',
      timestamp: 1,
      response: {
        opcode: 1,
        payloadData:
          '{"action":"spin","roundId":"x1"}'
      }
    },
    'sent'
  );

  const entry =
    recorder.active.get(
      'root:unknown-ws'
    );

  assert.ok(entry);
  assert.equal(
    entry.__resourceType,
    'WebSocket'
  );
  assert.equal(
    entry._webSocketUnknownUrl,
    true
  );
  assert.equal(recorder.wsFrames, 1);
  assert.equal(recorder.wsSpins, 1);
});
