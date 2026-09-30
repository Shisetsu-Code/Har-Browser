'use strict';

const TEXTUAL_TYPES = new Set(['Document', 'XHR', 'Fetch', 'Other']);

function headersToArray(headers = {}) {
  return Object.entries(headers).map(([name, value]) => ({
    name,
    value: String(value)
  }));
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

function utf8Size(value = '') {
  return Buffer.byteLength(String(value), 'utf8');
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

class HarRecorder {
  constructor(webContents, options = {}) {
    this.webContents = webContents;
    this.maxBodyBytes = options.maxBodyBytes ?? 8 * 1024 * 1024;
    this.onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
    this._messageListener = (_event, method, params) => this._onMessage(method, params);
    this._detachListener = () => {
      this.recording = false;
      this.onUpdate();
    };
    this.reset();
  }

  reset() {
    this.recording = false;
    this.startedAt = null;
    this.entries = [];
    this.active = new Map();
    this.webSockets = new Map();
    this.pendingBodies = new Set();
    this.totalBytes = 0;
    this.wsFrames = 0;
  }

  async start() {
    if (this.recording) return;

    this.reset();
    this.startedAt = new Date();

    const dbg = this.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach();

    dbg.on('message', this._messageListener);
    dbg.on('detach', this._detachListener);

    await dbg.sendCommand('Network.enable', {
      maxTotalBufferSize: 100 * 1024 * 1024,
      maxResourceBufferSize: 16 * 1024 * 1024,
      maxPostDataSize: 8 * 1024 * 1024
    });

    this.recording = true;
    this.onUpdate();
  }

  async stop() {
    if (!this.startedAt) return this.toJSON();

    // Freeze capture first so no new CDP events race with shutdown.
    // Let any in-flight response-body reads finish before finalizing entries.
    this.recording = false;
    await Promise.allSettled([...this.pendingBodies]);

    for (const record of [...this.active.values()]) {
      this._finalize(record);
    }

    const dbg = this.webContents.debugger;
    if (dbg.isAttached()) {
      try {
        await dbg.sendCommand('Network.disable');
      } catch {
        // Target may have navigated or closed.
      }
      try {
        dbg.detach();
      } catch {
        // Already detached.
      }
    }

    dbg.removeListener('message', this._messageListener);
    dbg.removeListener('detach', this._detachListener);
    this.recording = false;
    this.onUpdate();
    return this.toJSON();
  }

  getStats() {
    return {
      recording: this.recording,
      requests: this.entries.length + this.active.size,
      bytes: this.totalBytes,
      wsFrames: this.wsFrames
    };
  }

  toJSON() {
    return {
      log: {
        version: '1.2',
        creator: {
          name: 'HAR Browser',
          version: '0.1.0'
        },
        pages: [{
          startedDateTime: (this.startedAt || new Date()).toISOString(),
          id: 'page_1',
          title: this.webContents.getTitle() || this.webContents.getURL() || 'Captured page',
          pageTimings: {}
        }],
        entries: [...this.entries]
          .sort((a, b) => new Date(a.startedDateTime) - new Date(b.startedDateTime))
          .map((entry) => {
            const copy = { ...entry };
            delete copy.__requestId;
            delete copy.__startTs;
            delete copy.__responseTs;
            delete copy.__endTs;
            delete copy.__finalized;
            delete copy.__resourceType;
            return copy;
          })
      }
    };
  }

  _onMessage(method, params) {
    if (!this.recording) return;

    switch (method) {
      case 'Network.requestWillBeSent':
        this._requestWillBeSent(params);
        break;
      case 'Network.responseReceived':
        this._responseReceived(params);
        break;
      case 'Network.loadingFinished':
        this._loadingFinished(params);
        break;
      case 'Network.loadingFailed':
        this._loadingFailed(params);
        break;
      case 'Network.webSocketCreated':
        this._webSocketCreated(params);
        break;
      case 'Network.webSocketWillSendHandshakeRequest':
        this._webSocketHandshakeRequest(params);
        break;
      case 'Network.webSocketHandshakeResponseReceived':
        this._webSocketHandshakeResponse(params);
        break;
      case 'Network.webSocketFrameSent':
        this._webSocketFrame(params, 'sent');
        break;
      case 'Network.webSocketFrameReceived':
        this._webSocketFrame(params, 'received');
        break;
      case 'Network.webSocketClosed':
        this._webSocketClosed(params);
        break;
      default:
        break;
    }
  }

  _requestWillBeSent(params) {
    const previous = this.active.get(params.requestId);
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
      timings: {
        blocked: -1,
        dns: -1,
        connect: -1,
        send: 0,
        wait: 0,
        receive: 0,
        ssl: -1
      },
      __requestId: params.requestId,
      __startTs: params.timestamp,
      __responseTs: null,
      __endTs: null,
      __resourceType: params.type || 'Other',
      __finalized: false,
      _initiator: params.initiator || undefined
    };

    if (postData !== undefined) {
      entry.request.postData = {
        mimeType: request.headers?.['Content-Type'] || request.headers?.['content-type'] || '',
        text: postData
      };
    }

    this.active.set(params.requestId, entry);
    this.onUpdate();
  }

  _responseReceived(params) {
    const entry = this.active.get(params.requestId);
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

  _loadingFinished(params) {
    const entry = this.active.get(params.requestId);
    if (!entry) return;

    entry.__endTs = params.timestamp;
    if (Number.isFinite(params.encodedDataLength)) {
      entry.response.bodySize = params.encodedDataLength;
      entry.response.content.size = params.encodedDataLength;
      this.totalBytes += params.encodedDataLength;
    }

    if (!this._shouldCaptureBody(entry, params.encodedDataLength)) {
      this._finalize(entry);
      return;
    }

    const promise = this.webContents.debugger
      .sendCommand('Network.getResponseBody', { requestId: params.requestId })
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

  _loadingFailed(params) {
    const entry = this.active.get(params.requestId);
    if (!entry) return;
    entry.__endTs = params.timestamp;
    entry.response._error = params.errorText || 'Network request failed';
    if (params.canceled) entry.response._canceled = true;
    this._finalize(entry);
  }

  _webSocketCreated(params) {
    this.webSockets.set(params.requestId, {
      url: params.url,
      frames: []
    });
  }

  _webSocketHandshakeRequest(params) {
    let entry = this.active.get(params.requestId);
    if (!entry) {
      entry = {
        pageref: 'page_1',
        startedDateTime: new Date().toISOString(),
        time: 0,
        request: {
          method: 'GET',
          url: this.webSockets.get(params.requestId)?.url || '',
          httpVersion: '',
          cookies: [],
          headers: [],
          queryString: queryString(this.webSockets.get(params.requestId)?.url || ''),
          headersSize: -1,
          bodySize: 0
        },
        response: responseTemplate(),
        cache: {},
        timings: {
          blocked: -1,
          dns: -1,
          connect: -1,
          send: 0,
          wait: 0,
          receive: 0,
          ssl: -1
        },
        __requestId: params.requestId,
        __startTs: params.timestamp,
        __responseTs: null,
        __endTs: null,
        __resourceType: 'WebSocket',
        __finalized: false
      };
      this.active.set(params.requestId, entry);
    }

    if (params.request?.headers) {
      entry.request.headers = headersToArray(params.request.headers);
    }
  }

  _webSocketHandshakeResponse(params) {
    const entry = this.active.get(params.requestId);
    if (!entry) return;
    this._applyResponse(entry, params.response, params.timestamp);
  }

  _webSocketFrame(params, direction) {
    const ws = this.webSockets.get(params.requestId);
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

  _webSocketClosed(params) {
    const entry = this.active.get(params.requestId);
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
      entry._webSocketFrames = ws.frames;
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
  normalizeHttpVersion
};
