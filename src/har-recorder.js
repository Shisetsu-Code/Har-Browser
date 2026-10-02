'use strict';

const TEXTUAL_TYPES = new Set(['Document', 'XHR', 'Fetch', 'Other']);
const PROTOCOL_BODY_LIMIT = 64 * 1024 * 1024;
const FULL_HAR_BODY_LIMIT = 32 * 1024 * 1024;
const CDP_TOTAL_BUFFER = 512 * 1024 * 1024;
const CDP_RESOURCE_BUFFER = 128 * 1024 * 1024;
const CDP_POST_BUFFER = 64 * 1024 * 1024;

function headersToArray(headers = {}) {
  const result = [];
  for (const [name, rawValue] of Object.entries(headers || {})) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      result.push({ name, value: String(value ?? '') });
    }
  }
  return result;
}

function headerValue(headers = {}, wantedName) {
  const wanted = String(wantedName).toLowerCase();
  for (const [name, rawValue] of Object.entries(headers || {})) {
    if (name.toLowerCase() !== wanted) continue;
    if (Array.isArray(rawValue)) return rawValue[0] ?? '';
    return rawValue ?? '';
  }
  return '';
}

function queryString(url) {
  try {
    return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function normalizeHttpVersion(protocol) {
  if (!protocol) return '';
  if (protocol === 'h2') return 'HTTP/2';
  if (protocol === 'h3') return 'HTTP/3';
  if (protocol.startsWith('http/')) return protocol.toUpperCase();
  return protocol;
}

function normalizeResourceType(type) {
  const value = String(type || '').toLowerCase();
  if (value === 'xhr') return 'XHR';
  if (value === 'fetch') return 'Fetch';
  if (value === 'websocket') return 'WebSocket';
  if (value === 'mainframe' || value === 'subframe') return 'Document';
  if (value === 'other') return 'Other';
  return value ? value[0].toUpperCase() + value.slice(1) : 'Other';
}

function isGameOnlyEntry(entry) {
  const method = String(entry?.request?.method || 'GET').toUpperCase();
  const url = String(entry?.request?.url || '');
  const resourceType = String(entry?.__resourceType || '').toLowerCase();

  if (method === 'OPTIONS') return false;
  if (url.startsWith('blob:') || url.startsWith('data:')) return false;
  if (entry?._webSocketFrames?.length) return true;
  if (['xhr', 'fetch', 'websocket', 'eventsource'].includes(resourceType)) return true;
  if (!['GET', 'HEAD'].includes(method)) return true;

  return false;
}

function isBodylessResponse(entry) {
  const method = String(entry?.request?.method || 'GET').toUpperCase();
  const status = Number(entry?.response?.status || 0);

  return (
    method === 'HEAD' ||
    status === 204 ||
    status === 205 ||
    status === 304
  );
}

function bodyCaptureLimit(entry, gameOnly, maxBodyBytes, maxProtocolBodyBytes) {
  if (isGameOnlyEntry(entry)) return maxProtocolBodyBytes;
  if (gameOnly) return 0;

  const url = String(entry?.request?.url || '');
  if (url.startsWith('blob:') || url.startsWith('data:')) return 0;

  return maxBodyBytes;
}

function bufferLooksText(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (buffer.length === 0) return true;

  let printable = 0;

  for (const byte of buffer) {
    if (
      byte === 9 ||
      byte === 10 ||
      byte === 13 ||
      (byte >= 32 && byte <= 126) ||
      byte >= 0xC2
    ) {
      printable += 1;
    }
  }

  return printable / buffer.length >= 0.85;
}

function parseWebSocketText(text) {
  const raw = String(text ?? '');
  const trimmed = raw.trim();

  const result = {
    format: 'text',
    text: raw
  };

  if (!trimmed) return result;

  try {
    result.format = 'json';
    result.parsed = JSON.parse(trimmed);
    return result;
  } catch {}

  // Socket.IO EVENT packet: 42["event", {...}]
  if (trimmed.startsWith('42')) {
    try {
      const parsed = JSON.parse(trimmed.slice(2));

      result.format = 'socket.io';
      result.protocol = 'socket.io';
      result.packetType = 'event';
      result.parsed = parsed;

      if (
        Array.isArray(parsed) &&
        typeof parsed[0] === 'string'
      ) {
        result.eventName = parsed[0];
        result.eventData =
          parsed.length > 2
            ? parsed.slice(1)
            : parsed[1];
      }

      return result;
    } catch {}
  }

  // Engine.IO packets may prefix a JSON payload with a one-byte packet type.
  if (
    /^[0-6][\[{]/.test(trimmed)
  ) {
    try {
      result.format = 'engine.io';
      result.protocol = 'engine.io';
      result.packetType = trimmed[0];
      result.parsed =
        JSON.parse(trimmed.slice(1));
      return result;
    } catch {}
  }

  if (
    trimmed.includes('=') &&
    (trimmed.includes('&') || /^[^=\s]+=[^\s]*$/.test(trimmed))
  ) {
    try {
      const params =
        new URLSearchParams(trimmed);

      const parsed = {};

      for (const [key, value] of params.entries()) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) {
          parsed[key] =
            Array.isArray(parsed[key])
              ? [...parsed[key], value]
              : [parsed[key], value];
        } else {
          parsed[key] = value;
        }
      }

      if (Object.keys(parsed).length) {
        result.format = 'querystring';
        result.parsed = parsed;
      }
    } catch {}
  }

  return result;
}

function decodeWebSocketPayload(payloadData, opcode) {
  const payload = String(payloadData ?? '');
  const numericOpcode = Number(opcode);

  if (numericOpcode === 2) {
    let bytes;

    try {
      bytes = Buffer.from(payload, 'base64');
    } catch {
      bytes = Buffer.alloc(0);
    }

    if (bufferLooksText(bytes)) {
      const decoded =
        parseWebSocketText(
          bytes.toString('utf8')
        );

      return {
        ...decoded,
        opcodeName: 'binary',
        encoding: 'base64->utf8',
        byteLength: bytes.length,
        base64: payload
      };
    }

    return {
      format: 'binary',
      opcodeName: 'binary',
      encoding: 'base64',
      byteLength: bytes.length,
      base64: payload
    };
  }

  const decoded =
    parseWebSocketText(payload);

  return {
    ...decoded,
    opcodeName:
      numericOpcode === 1
        ? 'text'
        : numericOpcode === 8
          ? 'close'
          : numericOpcode === 9
            ? 'ping'
            : numericOpcode === 10
              ? 'pong'
              : 'other',
    encoding: 'utf8',
    byteLength: utf8Size(payload)
  };
}

function collectSemanticTokens(value, out = [], depth = 0) {
  if (depth > 5 || out.length > 250) return out;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectSemanticTokens(item, out, depth + 1);
    }
    return out;
  }

  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push(String(key).toLowerCase());
      collectSemanticTokens(child, out, depth + 1);
    }
    return out;
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number'
  ) {
    out.push(String(value).toLowerCase());
  }

  return out;
}

function extractWebSocketCorrelation(decoded) {
  const preferredKeys = new Set([
    'requestid',
    'request_id',
    'correlationid',
    'correlation_id',
    'rid',
    'seq',
    'sequence',
    'transactionid',
    'transaction_id',
    'txid',
    'spinid',
    'spin_id',
    'roundid',
    'round_id',
    'messageid',
    'message_id',
    'msgid'
  ]);

  function walk(value, depth = 0) {
    if (depth > 4 || value === null || value === undefined) return null;

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item, depth + 1);
        if (found) return found;
      }
      return null;
    }

    if (typeof value !== 'object') return null;

    for (const [key, child] of Object.entries(value)) {
      const normalized = String(key).toLowerCase();

      if (
        preferredKeys.has(normalized) &&
        (typeof child === 'string' || typeof child === 'number')
      ) {
        return {
          key,
          value: String(child)
        };
      }
    }

    // A top-level generic id is useful, but avoid recursively treating every
    // symbol/object id inside a game result as a correlation id.
    if (
      depth === 0 &&
      Object.prototype.hasOwnProperty.call(value, 'id') &&
      (
        typeof value.id === 'string' ||
        typeof value.id === 'number'
      )
    ) {
      return {
        key: 'id',
        value: String(value.id)
      };
    }

    for (const child of Object.values(value)) {
      const found = walk(child, depth + 1);
      if (found) return found;
    }

    return null;
  }

  return walk(decoded?.parsed);
}

function classifyWebSocketGameEvent(decoded, direction) {
  if (!decoded) return null;

  const opcodeName =
    String(decoded.opcodeName || '').toLowerCase();

  if (
    ['ping', 'pong', 'close'].includes(opcodeName) ||
    decoded.text === '2' ||
    decoded.text === '3'
  ) {
    return {
      kind: 'heartbeat',
      direction,
      hints: []
    };
  }

  const tokens = [];

  if (decoded.eventName) {
    tokens.push(
      String(decoded.eventName).toLowerCase()
    );
  }

  collectSemanticTokens(
    decoded.parsed,
    tokens
  );

  if (
    decoded.format === 'text' &&
    decoded.text &&
    decoded.text.length <= 256
  ) {
    tokens.push(
      decoded.text.toLowerCase()
    );
  }

  const haystack =
    tokens.join(' ');

  const patterns = [
    {
      kind: 'buy-feature',
      regex: /\b(?:buy|purchase)[ _-]?(?:feature|bonus)|\bbonus[ _-]?buy\b|\bfeature[ _-]?buy\b/
    },
    {
      kind: 'free-spin',
      regex: /\bfree[ _-]?spins?\b|\bfreespins?\b/
    },
    {
      kind: 'spin',
      regex: /\bspins?\b/
    },
    {
      kind: 'bet',
      regex: /\bbet\b|\bwager\b|\bstake\b/
    },
    {
      kind: 'bonus',
      regex: /\bbonus\b|\bfeature\b/
    },
    {
      kind: 'round',
      regex: /\bround\b/
    }
  ];

  for (const candidate of patterns) {
    if (!candidate.regex.test(haystack)) continue;

    const hints =
      tokens
        .filter((token) =>
          candidate.regex.test(token)
        )
        .slice(0, 8);

    const correlation =
      extractWebSocketCorrelation(decoded);

    return {
      kind: candidate.kind,
      direction,
      hints,
      correlationId:
        correlation?.value,
      correlationKey:
        correlation?.key
    };
  }

  return null;
}

function isStructuredWebSocketPayload(decoded) {
  return Boolean(
    decoded &&
    (
      decoded.parsed !== undefined ||
      decoded.format === 'json' ||
      decoded.format === 'socket.io' ||
      decoded.format === 'engine.io' ||
      decoded.format === 'querystring'
    )
  );
}

function entryTrafficBytes(entry) {
  const responseBytes = Number(entry?.response?.bodySize);
  const requestBytes = Number(entry?.request?.bodySize);
  return (Number.isFinite(responseBytes) && responseBytes > 0 ? responseBytes : 0) +
    (Number.isFinite(requestBytes) && requestBytes > 0 ? requestBytes : 0);
}

function utf8Size(value = '') {
  return Buffer.byteLength(String(value), 'utf8');
}

function timestampToIso(timestamp) {
  if (!Number.isFinite(timestamp)) return new Date().toISOString();
  if (timestamp > 1e12) return new Date(timestamp).toISOString();
  if (timestamp > 1e9) return new Date(timestamp * 1000).toISOString();
  return new Date().toISOString();
}

function timestampToMs(timestamp) {
  if (!Number.isFinite(timestamp)) return Date.now();
  if (timestamp > 1e12) return timestamp;
  if (timestamp > 1e9) return timestamp * 1000;
  return Date.now();
}

function statusTextFromLine(statusLine = '') {
  const match = String(statusLine).match(/^\S+\s+\d{3}\s*(.*)$/);
  return match ? match[1] : '';
}

function uploadDataToText(uploadData = []) {
  if (!Array.isArray(uploadData) || uploadData.length === 0) return null;

  const parts = [];
  for (const item of uploadData) {
    if (item?.bytes !== undefined) {
      try {
        const bytes = Buffer.isBuffer(item.bytes) ? item.bytes : Buffer.from(item.bytes);
        parts.push(bytes.toString('utf8'));
      } catch {
        parts.push('[binary upload data]');
      }
    } else if (item?.file) {
      parts.push(`[file:${item.file}]`);
    } else if (item?.blobUUID) {
      parts.push(`[blob:${item.blobUUID}]`);
    }
  }

  return parts.length ? parts.join('') : null;
}

function responseTemplate() {
  return {
    status: 0,
    statusText: '',
    httpVersion: '',
    cookies: [],
    headers: [],
    content: {
      size: 0,
      mimeType: ''
    },
    redirectURL: '',
    headersSize: -1,
    bodySize: -1
  };
}

function timingsTemplate() {
  return {
    blocked: -1,
    dns: -1,
    connect: -1,
    send: 0,
    wait: 0,
    receive: 0,
    ssl: -1
  };
}

function mergeEntry(base, richer) {
  const out = {
    ...base,
    request: { ...base.request },
    response: {
      ...base.response,
      content: { ...base.response.content }
    },
    timings: { ...base.timings }
  };

  if (!out.request.postData && richer.request?.postData) {
    out.request.postData = richer.request.postData;
    out.request.bodySize = richer.request.bodySize;
  }

  if ((!out.request.headers || out.request.headers.length === 0) && richer.request?.headers?.length) {
    out.request.headers = richer.request.headers;
  }

  if (richer.response) {
    if (!out.response.status && richer.response.status) out.response.status = richer.response.status;
    if (!out.response.statusText && richer.response.statusText) out.response.statusText = richer.response.statusText;
    if (!out.response.httpVersion && richer.response.httpVersion) out.response.httpVersion = richer.response.httpVersion;
    if ((!out.response.headers || out.response.headers.length === 0) && richer.response.headers?.length) {
      out.response.headers = richer.response.headers;
    }
    if (richer.response.content) {
      out.response.content = {
        ...out.response.content,
        ...richer.response.content
      };
    }
  }

  if (richer._webSocketFrames?.length) out._webSocketFrames = richer._webSocketFrames;
  if (richer._initiator) out._initiator = richer._initiator;
  if (richer.serverIPAddress) out.serverIPAddress = richer.serverIPAddress;
  if (richer.connection) out.connection = richer.connection;
  if (richer._fromDiskCache) out._fromDiskCache = true;
  if (richer._fromServiceWorker) out._fromServiceWorker = true;

  if (richer.time > 0) {
    out.time = richer.time;
    out.timings = richer.timings;
  }

  out._captureSources = ['webRequest', 'cdp'];
  return out;
}

class HarRecorder {
  constructor(webContents, options = {}) {
    this.webContents = webContents;
    this.networkTap = options.networkTap || null;
    this.cdpSessionsProvider =
      typeof options.cdpSessionsProvider === 'function'
        ? options.cdpSessionsProvider
        : () => [];
    this.gameOnly = options.gameOnly !== false;
    this.maxBodyBytes = options.maxBodyBytes ?? FULL_HAR_BODY_LIMIT;
    this.maxProtocolBodyBytes =
      options.maxProtocolBodyBytes ?? PROTOCOL_BODY_LIMIT;
    this.stopDrainMs = options.stopDrainMs ?? 1500;
    this.quietWindowMs = options.quietWindowMs ?? 200;
    this.onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
    this._messageListener = (_event, method, params, sessionId) =>
      this._onMessage(method, params, sessionId);
    this._detachListener = (_event, reason) => {
      this.cdpAvailable = false;
      this.cdpError = reason || 'detached';
      this.onUpdate();
    };
    this.reset();
  }

  reset() {
    this.recording = false;
    this.startedAt = null;

    this.entries = [];
    this.active = new Map();

    this.webEntries = [];
    this.webActive = new Map();

    this.webSockets = new Map();
    this.pendingBodies = new Set();
    this.streamBodies = new Map();

    this.totalBytes = 0;
    this.wsFrames = 0;
    this.wsGameEvents = 0;
    this.wsSpins = 0;
    this.wsTransactions = 0;
    this.webEvents = 0;
    this.cdpEvents = 0;
    this.cdpAvailable = false;
    this.cdpError = null;
    this.ownsDebugger = false;
    this.stopping = false;
    this.lastNetworkEventAt = 0;
  }

  setGameOnly(enabled) {
    this.gameOnly = Boolean(enabled);
    this.onUpdate();
  }

  _sendCommand(method, params = {}, sessionId) {
    const dbg = this.webContents.debugger;

    if (
      sessionId === undefined ||
      sessionId === null ||
      sessionId === ''
    ) {
      return dbg.sendCommand(method, params);
    }

    return dbg.sendCommand(
      method,
      params,
      sessionId
    );
  }

  async start() {
    if (this.recording) return;

    this.reset();
    this.startedAt = new Date();
    this.recording = true;

    this.networkTap?.register(this.webContents.id, this);
    this.onUpdate();

    const dbg = this.webContents.debugger;

    try {
      if (!dbg.isAttached()) {
        dbg.attach();
        this.ownsDebugger = true;
      }

      dbg.on('message', this._messageListener);
      dbg.on('detach', this._detachListener);

      // REC is not considered started until Network is enabled. This removes
      // the race where the user spins immediately after pressing REC.
      await this._enableCdp();
    } catch (error) {
      this.cdpAvailable = false;
      this.cdpError = error?.message || String(error);
      this.recording = false;

      this.networkTap?.unregister(this.webContents.id, this);

      try {
        dbg.removeListener('message', this._messageListener);
        dbg.removeListener('detach', this._detachListener);
      } catch {}

      this.onUpdate();

      throw new Error(
        `Full network capture unavailable: ${this.cdpError}`
      );
    }
  }

  async _enableCdp() {
    const dbg = this.webContents.debugger;

    await this._enableCaptureDomains(null);

    const existingSessions =
      this.cdpSessionsProvider?.() || [];

    for (const sessionId of existingSessions) {
      try {
        await this._enableCaptureDomains(sessionId);
      } catch {
        // One stale/detached child target must not disable root capture.
      }
    }

    this.cdpAvailable = true;
    this.cdpError = null;
    this.onUpdate();

    try {
      await dbg.sendCommand('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true
      });
    } catch {
      // Existing sessions above + webRequest remain active fallbacks.
    }
  }

  async _enableCaptureDomains(sessionId) {
    const dbg = this.webContents.debugger;

    const baseOptions = {
      maxTotalBufferSize: CDP_TOTAL_BUFFER,
      maxResourceBufferSize: CDP_RESOURCE_BUFFER,
      maxPostDataSize: CDP_POST_BUFFER
    };

    try {
      await this._sendCommand(
        'Network.enable',
        {
          ...baseOptions,
          enableDurableMessages: true
        },
        sessionId
      );
    } catch {
      // Older Chromium builds may not expose durable messages.
      await this._sendCommand(
        'Network.enable',
        baseOptions,
        sessionId
      );
    }
  }

  async stop() {
    if (!this.startedAt) return this.toJSON();
    if (this.stopping) {
      await this._waitForPendingBodies();
      return this.toJSON();
    }

    this.stopping = true;

    // Keep listening briefly so loadingFinished + getResponseBody can arrive
    // after the server response but before the HAR is frozen.
    await this._waitForNetworkQuiet();

    this.recording = false;
    this.networkTap?.unregister(this.webContents.id, this);

    await this._waitForPendingBodies();

    for (const record of [...this.active.values()]) {
      if (isGameOnlyEntry(record) && record.response?.content?.text === undefined) {
        record.response.content._bodyCaptureStatus =
          record.response.content._bodyCaptureStatus || 'missing-before-stop';
      }
      this._finalize(record);
    }

    for (const record of [...this.webActive.values()]) {
      this._finalizeWeb(record);
    }

    const dbg = this.webContents.debugger;

    try {
      dbg.removeListener('message', this._messageListener);
      dbg.removeListener('detach', this._detachListener);
    } catch {}

    if (dbg.isAttached() && this.ownsDebugger) {
      try {
        await dbg.sendCommand('Network.disable');
      } catch {}
      try {
        dbg.detach();
      } catch {}
    }

    this.cdpAvailable = false;
    this.stopping = false;
    this.onUpdate();
    return this.toJSON();
  }

  async _waitForPendingBodies() {
    for (let pass = 0; pass < 4; pass += 1) {
      const pending = [...this.pendingBodies];
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
  }

  async _waitForNetworkQuiet() {
    const deadline = Date.now() + this.stopDrainMs;

    while (Date.now() < deadline) {
      const quietFor =
        Date.now() - (this.lastNetworkEventAt || Date.now());

      const protocolActive =
        [...this.active.values()].some(isGameOnlyEntry);

      if (
        quietFor >= this.quietWindowMs &&
        !protocolActive &&
        this.pendingBodies.size === 0
      ) {
        return;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, 25)
      );
    }
  }

  getStats() {
    const primaryCandidates = [...this.webEntries, ...this.webActive.values()];
    const fallbackCandidates = [...this.entries, ...this.active.values()];
    const candidates = primaryCandidates.length ? primaryCandidates : fallbackCandidates;
    const visibleCandidates = this.gameOnly
      ? candidates.filter(isGameOnlyEntry)
      : candidates;

    return {
      recording: this.recording,
      requests: visibleCandidates.length,
      bytes: this.gameOnly
        ? visibleCandidates.reduce((sum, entry) => sum + entryTrafficBytes(entry), 0)
        : this.totalBytes,
      wsFrames: this.wsFrames,
      wsGameEvents: this.wsGameEvents,
      wsSpins: this.wsSpins,
      wsTransactions: this.wsTransactions,
      webEvents: this.webEvents,
      cdpEvents: this.cdpEvents,
      cdpAvailable: this.cdpAvailable,
      cdpError: this.cdpError
    };
  }

  toJSON() {
    const entries = this._mergedEntries()
      .filter((entry) => !this.gameOnly || isGameOnlyEntry(entry));

    return {
      log: {
        version: '1.2',
        creator: {
          name: 'HAR Browser',
          version: '0.6.1'
        },
        pages: [{
          startedDateTime: (this.startedAt || new Date()).toISOString(),
          id: 'page_1',
          title: this.webContents.getTitle() || this.webContents.getURL() || 'Captured page',
          pageTimings: {}
        }],
        entries: entries
          .sort((a, b) => new Date(a.startedDateTime) - new Date(b.startedDateTime))
          .map((entry) => this._sanitize(entry))
      }
    };
  }

  _sanitize(entry) {
    const copy = { ...entry };
    delete copy.__requestId;
    delete copy.__startTs;
    delete copy.__responseTs;
    delete copy.__endTs;
    delete copy.__finalized;
    delete copy.__resourceType;
    delete copy.__cdpRequestId;
    delete copy.__startWallMs;
    delete copy.__responseWallMs;
    delete copy.__endWallMs;
    delete copy.__source;
    return copy;
  }

  _mergedEntries() {
    if (this.webEntries.length === 0) return [...this.entries];
    if (this.entries.length === 0) return [...this.webEntries];

    const cdp = [...this.entries];
    const used = new Set();
    const merged = [];

    for (const webEntry of this.webEntries) {
      const webTime = Date.parse(webEntry.startedDateTime);
      let bestIndex = -1;
      let bestDelta = Infinity;

      for (let i = 0; i < cdp.length; i += 1) {
        if (used.has(i)) continue;
        const candidate = cdp[i];
        if (candidate.request?.method !== webEntry.request?.method) continue;
        if (candidate.request?.url !== webEntry.request?.url) continue;

        const delta = Math.abs(Date.parse(candidate.startedDateTime) - webTime);
        if (delta <= 2500 && delta < bestDelta) {
          bestIndex = i;
          bestDelta = delta;
        }
      }

      if (bestIndex >= 0) {
        used.add(bestIndex);
        merged.push(mergeEntry(webEntry, cdp[bestIndex]));
      } else {
        merged.push(webEntry);
      }
    }

    for (let i = 0; i < cdp.length; i += 1) {
      if (!used.has(i)) merged.push(cdp[i]);
    }

    return merged;
  }

  handleWebRequest(stage, details) {
    if (!this.recording) return;
    this.lastNetworkEventAt = Date.now();
    this.webEvents += 1;

    switch (stage) {
      case 'beforeRequest':
        this._webBeforeRequest(details);
        break;
      case 'beforeSendHeaders':
        this._webBeforeSendHeaders(details);
        break;
      case 'headersReceived':
        this._webHeadersReceived(details);
        break;
      case 'beforeRedirect':
        this._webBeforeRedirect(details);
        break;
      case 'completed':
        this._webCompleted(details);
        break;
      case 'error':
        this._webError(details);
        break;
      default:
        break;
    }

    this.onUpdate();
  }

  _webBeforeRequest(details) {
    const id = String(details.id);
    const postData = uploadDataToText(details.uploadData);
    const entry = {
      pageref: 'page_1',
      startedDateTime: timestampToIso(details.timestamp),
      time: 0,
      request: {
        method: details.method || 'GET',
        url: details.url || '',
        httpVersion: '',
        cookies: [],
        headers: [],
        queryString: queryString(details.url),
        headersSize: -1,
        bodySize: postData === null ? 0 : utf8Size(postData)
      },
      response: responseTemplate(),
      cache: {},
      timings: timingsTemplate(),
      __requestId: id,
      __startWallMs: timestampToMs(details.timestamp),
      __responseWallMs: null,
      __endWallMs: null,
      __resourceType: normalizeResourceType(details.resourceType),
      __finalized: false,
      __source: 'webRequest',
      _initiatorOrigin: details.initiatorOrigin || undefined,
      _referrer: details.referrer || undefined
    };

    if (postData !== null) {
      entry.request.postData = {
        mimeType: '',
        text: postData
      };
      entry.request._postDataCaptureStatus = 'captured-webRequest';
    } else if (!['GET', 'HEAD'].includes(String(details.method || '').toUpperCase())) {
      entry.request._postDataCaptureStatus = 'not-present-webRequest';
    } else {
      entry.request._postDataCaptureStatus = 'not-applicable';
    }

    this.webActive.set(id, entry);
  }

  _webBeforeSendHeaders(details) {
    const entry = this.webActive.get(String(details.id));
    if (!entry) return;

    entry.request.headers = headersToArray(details.requestHeaders);

    if (entry.request.postData) {
      entry.request.postData.mimeType =
        headerValue(details.requestHeaders, 'content-type') || '';
    }
  }

  _webHeadersReceived(details) {
    const entry = this.webActive.get(String(details.id));
    if (!entry) return;

    entry.__responseWallMs = timestampToMs(details.timestamp);
    entry.response.status = details.statusCode || 0;
    entry.response.statusText = statusTextFromLine(details.statusLine);
    entry.response.headers = headersToArray(details.responseHeaders);
    entry.response.content.mimeType =
      String(headerValue(details.responseHeaders, 'content-type')).split(';')[0] || '';

    const contentLength = Number(headerValue(details.responseHeaders, 'content-length'));
    if (Number.isFinite(contentLength) && contentLength >= 0) {
      entry.response.bodySize = contentLength;
      entry.response.content.size = contentLength;
    }

    entry.response.redirectURL =
      headerValue(details.responseHeaders, 'location') || '';
  }

  _webBeforeRedirect(details) {
    const entry = this.webActive.get(String(details.id));
    if (!entry) return;

    this._webHeadersReceived(details);
    entry.__endWallMs = timestampToMs(details.timestamp);
    entry.response.redirectURL = details.redirectURL || entry.response.redirectURL;
    if (details.ip) entry.serverIPAddress = details.ip;
    if (details.fromCache) entry._fromDiskCache = true;
    this._finalizeWeb(entry);
  }

  _webCompleted(details) {
    const entry = this.webActive.get(String(details.id));
    if (!entry) return;

    entry.__endWallMs = timestampToMs(details.timestamp);
    entry.response.status = details.statusCode || entry.response.status;
    entry.response.statusText =
      statusTextFromLine(details.statusLine) || entry.response.statusText;

    if (details.responseHeaders) {
      entry.response.headers = headersToArray(details.responseHeaders);
      entry.response.content.mimeType =
        String(headerValue(details.responseHeaders, 'content-type')).split(';')[0] ||
        entry.response.content.mimeType;

      const contentLength = Number(headerValue(details.responseHeaders, 'content-length'));
      if (Number.isFinite(contentLength) && contentLength >= 0) {
        entry.response.bodySize = contentLength;
        entry.response.content.size = contentLength;
      }
    }

    if (details.fromCache) entry._fromDiskCache = true;
    if (details.error) entry.response._error = details.error;

    if (entry.response.bodySize > 0) this.totalBytes += entry.response.bodySize;
    this._finalizeWeb(entry);
  }

  _webError(details) {
    const entry = this.webActive.get(String(details.id));
    if (!entry) return;

    entry.__endWallMs = timestampToMs(details.timestamp);
    entry.response._error = details.error || 'Network request failed';
    this._finalizeWeb(entry);
  }

  _finalizeWeb(entry) {
    if (!entry || entry.__finalized) return;
    entry.__finalized = true;

    const start = entry.__startWallMs;
    const response = entry.__responseWallMs ?? entry.__endWallMs ?? start;
    const end = entry.__endWallMs ?? response;

    if (Number.isFinite(start) && Number.isFinite(end)) {
      entry.time = Math.max(0, end - start);
      entry.timings.wait = Math.max(0, response - start);
      entry.timings.receive = Math.max(0, end - response);
    }

    if (this.webActive.get(entry.__requestId) === entry) {
      this.webActive.delete(entry.__requestId);
    }

    if (
      isGameOnlyEntry(entry) &&
      entry.response.content.text === undefined &&
      !entry.response.content._bodyCaptureStatus
    ) {
      entry.response.content._bodyCaptureStatus = 'awaiting-cdp-merge';
    }

    this.webEntries.push(entry);
  }

  _onMessage(method, params, sessionId) {
    if (!this.recording) return;
    this.lastNetworkEventAt = Date.now();
    this.cdpEvents += 1;

    if (method === 'Target.attachedToTarget') {
      const childSessionId = params?.sessionId;

      if (childSessionId) {
        const promise =
          this._enableCaptureDomains(childSessionId)
            .catch(() => {});

        this.pendingBodies.add(promise);

        promise.finally(() => {
          this.pendingBodies.delete(promise);
        });
      }

      return;
    }

    switch (method) {
      case 'Network.requestWillBeSent':
        this._requestWillBeSent(params, sessionId);
        break;
      case 'Network.responseReceived':
        this._responseReceived(params, sessionId);
        break;
      case 'Network.dataReceived':
        this._dataReceived(params, sessionId);
        break;
      case 'Network.loadingFinished':
        this._loadingFinished(params, sessionId);
        break;
      case 'Network.loadingFailed':
        this._loadingFailed(params, sessionId);
        break;
      case 'Network.webSocketCreated':
        this._webSocketCreated(params, sessionId);
        break;
      case 'Network.webSocketWillSendHandshakeRequest':
        this._webSocketHandshakeRequest(params, sessionId);
        break;
      case 'Network.webSocketHandshakeResponseReceived':
        this._webSocketHandshakeResponse(params, sessionId);
        break;
      case 'Network.webSocketFrameSent':
        this._webSocketFrame(params, 'sent', sessionId);
        break;
      case 'Network.webSocketFrameReceived':
        this._webSocketFrame(params, 'received', sessionId);
        break;
      case 'Network.webSocketClosed':
        this._webSocketClosed(params, sessionId);
        break;
      default:
        break;
    }
  }

  _applyCapturedBody(entry, record, source) {
    if (!entry || !record) return;

    entry.response.content.text =
      record.body ?? '';

    if (record.base64Encoded) {
      entry.response.content.encoding = 'base64';
    } else {
      delete entry.response.content.encoding;
    }

    entry.response.content._bodyCaptureStatus =
      record.body === ''
        ? 'empty'
        : 'captured';

    entry.response.content._bodyCaptureSource =
      source;

    const size =
      record.base64Encoded
        ? Math.floor(
            String(record.body || '').length * 0.75
          )
        : utf8Size(record.body || '');

    if (
      !Number.isFinite(entry.response.content.size) ||
      entry.response.content.size <= 0
    ) {
      entry.response.content.size = size;
    }
  }

  _isTextualMime(mimeType = '') {
    const mime = String(mimeType).toLowerCase();

    return (
      mime.startsWith('text/') ||
      mime.includes('json') ||
      mime.includes('javascript') ||
      mime.includes('xml') ||
      mime.includes('x-www-form-urlencoded')
    );
  }

  _startResponseStream(entry, requestId, sessionId) {
    if (!entry || isBodylessResponse(entry)) return;

    const decision = this._bodyCaptureDecision(
      entry,
      entry.response?.content?.size
    );

    if (!decision.capture) return;

    const key = this._cdpKey(requestId, sessionId);

    if (this.streamBodies.has(key)) return;

    const record = {
      chunks: [],
      started: false,
      failed: false,
      error: ''
    };

    this.streamBodies.set(key, record);

    const promise = this._sendCommand(
        'Network.streamResourceContent',
        { requestId },
        sessionId
      )
      .then((result) => {
        record.started = true;

        if (result?.bufferedData) {
          record.chunks.push(
            Buffer.from(
              result.bufferedData,
              'base64'
            )
          );
        }

        entry.response.content._bodyCaptureStatus =
          'streaming';

        entry.response.content._bodyCaptureSource =
          'network-stream';
      })
      .catch((error) => {
        record.failed = true;
        record.error =
          error?.message || String(error);

        entry.response.content._streamCaptureError =
          record.error;
      })
      .finally(() => {
        this.pendingBodies.delete(promise);
      });

    this.pendingBodies.add(promise);
  }

  _dataReceived(params, sessionId) {
    const key = this._cdpKey(
      params.requestId,
      sessionId
    );

    const record = this.streamBodies.get(key);

    if (!record || !params.data) return;

    try {
      record.chunks.push(
        Buffer.from(params.data, 'base64')
      );
    } catch (error) {
      record.failed = true;
      record.error =
        error?.message || String(error);
    }
  }

  _applyStreamBodyIfAvailable(entry) {
    const record =
      this.streamBodies.get(entry.__requestId);

    if (!record) return false;

    if (!record.started) {
      return false;
    }

    if (
      record.failed ||
      record.chunks.length === 0
    ) {
      this.streamBodies.delete(
        entry.__requestId
      );
      return false;
    }

    this.streamBodies.delete(
      entry.__requestId
    );

    const buffer = Buffer.concat(
      record.chunks
    );

    if (
      this._isTextualMime(
        entry.response.content.mimeType
      )
    ) {
      this._applyCapturedBody(
        entry,
        {
          body: buffer.toString('utf8'),
          base64Encoded: false
        },
        'network-stream'
      );
    } else {
      this._applyCapturedBody(
        entry,
        {
          body: buffer.toString('base64'),
          base64Encoded: true
        },
        'network-stream'
      );
    }

    entry.response.content.size =
      buffer.length;

    return true;
  }

  _cdpKey(requestId, sessionId) {
    return `${sessionId || 'root'}:${requestId}`;
  }

  _requestWillBeSent(params, sessionId) {
    const key = this._cdpKey(params.requestId, sessionId);
    const previous = this.active.get(key);
    if (previous && params.redirectResponse) {
      this._applyResponse(previous, params.redirectResponse, params.timestamp);
      previous.__endTs = params.timestamp;
      this._finalize(previous);
    }

    const request = params.request || {};
    const postData = request.postData;
    const entry = {
      pageref: 'page_1',
      startedDateTime: params.wallTime
        ? new Date(params.wallTime * 1000).toISOString()
        : new Date().toISOString(),
      time: 0,
      request: {
        method: request.method || 'GET',
        url: request.url || '',
        httpVersion: '',
        cookies: [],
        headers: headersToArray(request.headers),
        queryString: queryString(request.url),
        headersSize: -1,
        bodySize: postData ? utf8Size(postData) : 0
      },
      response: responseTemplate(),
      cache: {},
      timings: timingsTemplate(),
      __requestId: key,
      __cdpRequestId: params.requestId,
      __startTs: params.timestamp,
      __responseTs: null,
      __endTs: null,
      __resourceType: params.type || 'Other',
      __finalized: false,
      __source: 'cdp',
      _initiator: params.initiator || undefined
    };

    if (postData !== undefined) {
      entry.request.postData = {
        mimeType: headerValue(request.headers, 'content-type') || '',
        text: postData
      };
      entry.request._postDataCaptureStatus = 'captured-event';
    } else if (
      request.hasPostData === true ||
      !['GET', 'HEAD'].includes(String(request.method || '').toUpperCase())
    ) {
      entry.request._postDataCaptureStatus = 'pending';
      this._captureRequestPostData(
        entry,
        params.requestId,
        sessionId
      );
    } else {
      entry.request._postDataCaptureStatus = 'not-applicable';
    }

    this.active.set(key, entry);
    this.onUpdate();
  }

  _responseReceived(params, sessionId) {
    const entry =
      this.active.get(
        this._cdpKey(
          params.requestId,
          sessionId
        )
      );

    if (!entry) return;

    this._applyResponse(
      entry,
      params.response,
      params.timestamp
    );

    this._startResponseStream(
      entry,
      params.requestId,
      sessionId
    );
  }

  _applyResponse(entry, response = {}, timestamp) {
    entry.__responseTs = timestamp ?? entry.__responseTs;
    entry.response.status = response.status ?? entry.response.status;
    entry.response.statusText = response.statusText || '';
    entry.response.httpVersion = normalizeHttpVersion(response.protocol);
    entry.request.httpVersion = entry.response.httpVersion;
    entry.response.headers = headersToArray(response.headers);
    entry.response.content.mimeType = response.mimeType || '';
    entry.response.redirectURL =
      response.headers?.location ||
      response.headers?.Location ||
      '';
    entry.response.bodySize =
      Number.isFinite(response.encodedDataLength) ? response.encodedDataLength : -1;

    if (response.remoteIPAddress) entry.serverIPAddress = response.remoteIPAddress;
    if (response.connectionId !== undefined) entry.connection = String(response.connectionId);
    if (response.fromDiskCache) entry._fromDiskCache = true;
    if (response.fromServiceWorker) entry._fromServiceWorker = true;
  }

  _loadingFinished(params, sessionId) {
    const entry = this.active.get(this._cdpKey(params.requestId, sessionId));
    if (!entry) return;

    entry.__endTs = params.timestamp;

    if (Number.isFinite(params.encodedDataLength)) {
      entry.response.bodySize = params.encodedDataLength;
      entry.response.content.size = params.encodedDataLength;

      if (this.webEntries.length === 0 && this.webActive.size === 0) {
        this.totalBytes += params.encodedDataLength;
      }
    }

    if (
      entry.response.content.text !== undefined ||
      this._applyStreamBodyIfAvailable(entry)
    ) {
      this._finalize(entry);
      return;
    }

    if (isBodylessResponse(entry)) {
      entry.response.content._bodyCaptureStatus = 'not-applicable';
      this._finalize(entry);
      return;
    }

    const capture = this._bodyCaptureDecision(
      entry,
      params.encodedDataLength
    );

    if (!capture.capture) {
      entry.response.content._bodyCaptureStatus = capture.status;
      if (capture.limit > 0) {
        entry.response.content._bodyCaptureLimit = capture.limit;
      }
      this._finalize(entry);
      return;
    }

    entry.response.content._bodyCaptureStatus = 'pending';

    const promise = this._getResponseBodyWithRetry(
      params.requestId,
      sessionId,
      4
    )
      .then((result) => {
        if (!result) {
          throw new Error('CDP returned no response body');
        }

        this._applyCapturedBody(
          entry,
          {
            body: result.body ?? '',
            base64Encoded:
              Boolean(result.base64Encoded)
          },
          'network'
        );
      })
      .catch((error) => {
        entry.response.content._bodyUnavailable = true;
        entry.response.content._bodyCaptureStatus = 'unavailable';
        entry.response.content._bodyCaptureError =
          error?.message || String(error);
      })
      .finally(() => {
        this.pendingBodies.delete(promise);
        this._finalize(entry);
      });

    this.pendingBodies.add(promise);
  }

  _bodyCaptureDecision(entry, encodedDataLength) {
    const limit = bodyCaptureLimit(
      entry,
      this.gameOnly,
      this.maxBodyBytes,
      this.maxProtocolBodyBytes
    );

    if (limit <= 0) {
      return {
        capture: false,
        status: 'filtered',
        limit
      };
    }

    if (
      Number.isFinite(encodedDataLength) &&
      encodedDataLength > limit
    ) {
      return {
        capture: false,
        status: 'skipped-size-limit',
        limit
      };
    }

    return {
      capture: true,
      status: 'pending',
      limit
    };
  }

  async _getResponseBodyWithRetry(requestId, sessionId, attempts = 3) {
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this._sendCommand(
          'Network.getResponseBody',
          { requestId },
          sessionId
        );
      } catch (error) {
        lastError = error;

        if (attempt < attempts) {
          await new Promise((resolve) =>
            setTimeout(resolve, 20 * attempt)
          );
        }
      }
    }

    throw lastError || new Error('Unable to capture response body');
  }

  _captureRequestPostData(entry, requestId, sessionId) {
    const promise = this._sendCommand(
        'Network.getRequestPostData',
        { requestId },
        sessionId
      )
      .then((result) => {
        const postData = result?.postData;

        if (postData === undefined) {
          entry.request._postDataCaptureStatus = 'unavailable';
          return;
        }

        entry.request.postData = {
          mimeType:
            headerValue(
              Object.fromEntries(
                (entry.request.headers || []).map(
                  ({ name, value }) => [name, value]
                )
              ),
              'content-type'
            ) || '',
          text: postData
        };

        entry.request.bodySize = utf8Size(postData);
        entry.request._postDataCaptureStatus =
          postData === ''
            ? 'empty'
            : 'captured-cdp';
      })
      .catch((error) => {
        entry.request._postDataCaptureStatus = 'unavailable';
        entry.request._postDataCaptureError =
          error?.message || String(error);
      })
      .finally(() => {
        this.pendingBodies.delete(promise);
      });

    this.pendingBodies.add(promise);
  }

  _loadingFailed(params, sessionId) {
    const entry = this.active.get(this._cdpKey(params.requestId, sessionId));
    if (!entry) return;
    entry.__endTs = params.timestamp;
    entry.response._error = params.errorText || 'Network request failed';
    if (params.canceled) entry.response._canceled = true;
    this._finalize(entry);
  }

  _webSocketCreated(params, sessionId) {
    const key = this._cdpKey(params.requestId, sessionId);
    this.webSockets.set(key, {
      url: params.url,
      frames: [],
      transactions: [],
      pendingGameRequests: [],
      nextFrameId: 1
    });
  }

  _webSocketHandshakeRequest(params, sessionId) {
    const key = this._cdpKey(params.requestId, sessionId);
    let entry = this.active.get(key);
    if (!entry) {
      const url = this.webSockets.get(key)?.url || '';
      entry = {
        pageref: 'page_1',
        startedDateTime: new Date().toISOString(),
        time: 0,
        request: {
          method: 'GET',
          url,
          httpVersion: '',
          cookies: [],
          headers: [],
          queryString: queryString(url),
          headersSize: -1,
          bodySize: 0
        },
        response: responseTemplate(),
        cache: {},
        timings: timingsTemplate(),
        __requestId: key,
        __cdpRequestId: params.requestId,
        __startTs: params.timestamp,
        __responseTs: null,
        __endTs: null,
        __resourceType: 'WebSocket',
        __finalized: false,
        __source: 'cdp'
      };
      this.active.set(key, entry);
    }

    if (params.request?.headers) {
      entry.request.headers = headersToArray(params.request.headers);
    }
  }

  _webSocketHandshakeResponse(params, sessionId) {
    const entry = this.active.get(this._cdpKey(params.requestId, sessionId));
    if (!entry) return;
    this._applyResponse(entry, params.response, params.timestamp);
  }

  _webSocketFrame(params, direction, sessionId) {
    const ws =
      this.webSockets.get(
        this._cdpKey(
          params.requestId,
          sessionId
        )
      );

    if (!ws) return;

    const payloadData =
      params.response?.payloadData || '';

    const opcode =
      params.response?.opcode;

    const decoded =
      decodeWebSocketPayload(
        payloadData,
        opcode
      );

    const gameEvent =
      classifyWebSocketGameEvent(
        decoded,
        direction
      );

    const frame = {
      id: ws.nextFrameId++,
      direction,
      timestamp: params.timestamp,
      opcode,
      mask: params.response?.mask,
      size: decoded.byteLength,
      payloadData,
      decoded
    };

    if (gameEvent) {
      frame._gameEvent = gameEvent;
      this.wsGameEvents += 1;

      if (
        direction === 'sent' &&
        ['spin', 'free-spin'].includes(
          gameEvent.kind
        )
      ) {
        this.wsSpins += 1;
      }
    }

    ws.frames.push(frame);

    if (
      direction === 'sent' &&
      gameEvent &&
      gameEvent.kind !== 'heartbeat'
    ) {
      ws.pendingGameRequests.push({
        frameId: frame.id,
        timestamp: frame.timestamp,
        kind: gameEvent.kind,
        correlationId:
          gameEvent.correlationId || null
      });

      if (
        ws.pendingGameRequests.length > 100
      ) {
        ws.pendingGameRequests.splice(
          0,
          ws.pendingGameRequests.length - 100
        );
      }
    }

    if (
      direction === 'received' &&
      gameEvent?.kind !== 'heartbeat' &&
      (
        gameEvent ||
        isStructuredWebSocketPayload(decoded)
      )
    ) {
      let matchIndex = -1;
      let matchType = '';

      if (gameEvent?.correlationId) {
        matchIndex =
          ws.pendingGameRequests.findIndex(
            (pending) =>
              pending.correlationId &&
              pending.correlationId ===
                gameEvent.correlationId
          );

        if (matchIndex >= 0) {
          matchType = 'correlation-id';
        }
      }

      if (matchIndex < 0) {
        for (
          let index =
            ws.pendingGameRequests.length - 1;
          index >= 0;
          index -= 1
        ) {
          const pending =
            ws.pendingGameRequests[index];

          const deltaMs =
            (
              Number(frame.timestamp) -
              Number(pending.timestamp)
            ) * 1000;

          if (
            Number.isFinite(deltaMs) &&
            deltaMs >= 0 &&
            deltaMs <= 30000
          ) {
            matchIndex = index;
            matchType = 'nearest-response';
            break;
          }
        }
      }

      if (matchIndex >= 0) {
        const [pending] =
          ws.pendingGameRequests.splice(
            matchIndex,
            1
          );

        const latencyMs =
          (
            Number(frame.timestamp) -
            Number(pending.timestamp)
          ) * 1000;

        const transaction = {
          kind: pending.kind,
          requestFrameId:
            pending.frameId,
          responseFrameId:
            frame.id,
          requestTimestamp:
            pending.timestamp,
          responseTimestamp:
            frame.timestamp,
          latencyMs:
            Number.isFinite(latencyMs)
              ? Math.max(0, latencyMs)
              : null,
          match: matchType
        };

        if (pending.correlationId) {
          transaction.correlationId =
            pending.correlationId;
        }

        ws.transactions.push(
          transaction
        );

        const requestFrame =
          ws.frames.find(
            (candidate) =>
              candidate.id ===
              pending.frameId
          );

        if (requestFrame) {
          requestFrame._pairedWith =
            frame.id;
        }

        frame._pairedWith =
          pending.frameId;

        this.wsTransactions += 1;
      }
    }

    this.wsFrames += 1;
    this.totalBytes +=
      Number(decoded.byteLength) ||
      utf8Size(payloadData);

    this.onUpdate();
  }

  _webSocketClosed(params, sessionId) {
    const entry = this.active.get(this._cdpKey(params.requestId, sessionId));
    if (!entry) return;
    entry.__endTs = params.timestamp;
    this._finalize(entry);
  }

  _finalize(entry) {
    if (!entry || entry.__finalized) return;
    entry.__finalized = true;

    const start = entry.__startTs;
    const responseTs = entry.__responseTs ?? entry.__endTs ?? start;
    const end = entry.__endTs ?? responseTs;
    if (Number.isFinite(start) && Number.isFinite(end)) {
      entry.time = Math.max(0, (end - start) * 1000);
      entry.timings.wait = Math.max(0, (responseTs - start) * 1000);
      entry.timings.receive = Math.max(0, (end - responseTs) * 1000);
    }

    const ws = this.webSockets.get(entry.__requestId);

    if (ws?.frames?.length) {
      entry._webSocketFrames =
        ws.frames;

      entry._webSocketSummary = {
        url: ws.url,
        frames: ws.frames.length,
        sent: ws.frames.filter(
          (frame) =>
            frame.direction === 'sent'
        ).length,
        received: ws.frames.filter(
          (frame) =>
            frame.direction === 'received'
        ).length,
        gameEvents: ws.frames.filter(
          (frame) =>
            frame._gameEvent &&
            frame._gameEvent.kind !==
              'heartbeat'
        ).length,
        spinRequests: ws.frames.filter(
          (frame) =>
            frame.direction === 'sent' &&
            ['spin', 'free-spin'].includes(
              frame._gameEvent?.kind
            )
        ).length,
        transactions:
          ws.transactions.length
      };

      if (ws.transactions.length) {
        entry._webSocketTransactions =
          ws.transactions;
      }
    }

    if (this.active.get(entry.__requestId) === entry) {
      this.active.delete(entry.__requestId);
    }

    this.entries.push(entry);
    this.onUpdate();
  }
}

module.exports = {
  HarRecorder,
  headersToArray,
  queryString,
  normalizeHttpVersion,
  normalizeResourceType,
  uploadDataToText,
  timestampToIso,
  isGameOnlyEntry,
  isBodylessResponse,
  bodyCaptureLimit,
  mergeEntry,
  parseWebSocketText,
  decodeWebSocketPayload,
  extractWebSocketCorrelation,
  classifyWebSocketGameEvent,
  isStructuredWebSocketPayload
};
