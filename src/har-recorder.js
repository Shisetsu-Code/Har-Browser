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
    if (richer.response.content?.text !== undefined) {
      out.response.content = { ...out.response.content, ...richer.response.content };
    } else {
      if (!out.response.content.mimeType && richer.response.content?.mimeType) {
        out.response.content.mimeType = richer.response.content.mimeType;
      }
      if (!out.response.content.size && richer.response.content?.size) {
        out.response.content.size = richer.response.content.size;
      }
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

    this.totalBytes = 0;
    this.wsFrames = 0;
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

      void this._enableCdp().catch((error) => {
        this.cdpAvailable = false;
        this.cdpError = error.message;
        this.onUpdate();
      });
    } catch (error) {
      this.cdpAvailable = false;
      this.cdpError = error.message;
      this.onUpdate();
    }
  }

  async _enableCdp() {
    const dbg = this.webContents.debugger;

    await dbg.sendCommand('Network.enable', {
      maxTotalBufferSize: CDP_TOTAL_BUFFER,
      maxResourceBufferSize: CDP_RESOURCE_BUFFER,
      maxPostDataSize: CDP_POST_BUFFER
    });

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
      // webRequest remains the reliable capture path even if target auto-attach is unavailable.
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
          version: '0.5.1'
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

    this.webEntries.push(entry);
  }

  _onMessage(method, params, sessionId) {
    if (!this.recording) return;
    this.lastNetworkEventAt = Date.now();
    this.cdpEvents += 1;

    if (method === 'Target.attachedToTarget') {
      const childSessionId = params?.sessionId;
      if (childSessionId) {
        void this.webContents.debugger.sendCommand(
          'Network.enable',
          {
            maxTotalBufferSize: CDP_TOTAL_BUFFER,
            maxResourceBufferSize: CDP_RESOURCE_BUFFER,
            maxPostDataSize: CDP_POST_BUFFER
          },
          childSessionId
        ).catch(() => {});
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
        mimeType: request.headers?.['Content-Type'] || request.headers?.['content-type'] || '',
        text: postData
      };
    }

    this.active.set(key, entry);
    this.onUpdate();
  }

  _responseReceived(params, sessionId) {
    const entry = this.active.get(this._cdpKey(params.requestId, sessionId));
    if (!entry) return;
    this._applyResponse(entry, params.response, params.timestamp);
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

    if (!this._shouldCaptureBody(entry, params.encodedDataLength)) {
      this._finalize(entry);
      return;
    }

    const promise = this.webContents.debugger
      .sendCommand('Network.getResponseBody', { requestId: params.requestId }, sessionId)
      .then((result) => {
        if (!result || entry.__finalized) return;
        entry.response.content.text = result.body;
        if (result.base64Encoded) entry.response.content.encoding = 'base64';
        if (!entry.response.content.size) {
          entry.response.content.size = result.base64Encoded
            ? Math.floor(result.body.length * 0.75)
            : utf8Size(result.body);
        }
      })
      .catch(() => {
        entry.response.content._bodyUnavailable = true;
      })
      .finally(() => {
        this.pendingBodies.delete(promise);
        this._finalize(entry);
      });

    this.pendingBodies.add(promise);
  }

  _shouldCaptureBody(entry, encodedDataLength) {
    if (!TEXTUAL_TYPES.has(entry.__resourceType)) return false;
    if (Number.isFinite(encodedDataLength) && encodedDataLength > this.maxBodyBytes) return false;
    return true;
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
      frames: []
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
    const ws = this.webSockets.get(this._cdpKey(params.requestId, sessionId));
    if (!ws) return;

    const payloadData = params.response?.payloadData || '';
    ws.frames.push({
      direction,
      timestamp: params.timestamp,
      opcode: params.response?.opcode,
      mask: params.response?.mask,
      payloadData
    });
    this.wsFrames += 1;
    this.totalBytes += utf8Size(payloadData);
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
    if (ws?.frames?.length) entry._webSocketFrames = ws.frames;

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
  isGameOnlyEntry
};
