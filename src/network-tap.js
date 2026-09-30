'use strict';

class NetworkTap {
  constructor(session) {
    this.session = session;
    this.recorders = new Map();
    this.installed = false;
  }

  install() {
    if (this.installed) return;
    this.installed = true;

    const wr = this.session.webRequest;
    const filter = { urls: ['<all_urls>'] };

    wr.onBeforeRequest(filter, (details, callback) => {
      try {
        this._dispatch('beforeRequest', details);
      } finally {
        callback({});
      }
    });

    wr.onBeforeSendHeaders(filter, (details, callback) => {
      try {
        this._dispatch('beforeSendHeaders', details);
      } finally {
        callback({});
      }
    });

    wr.onHeadersReceived(filter, (details, callback) => {
      try {
        this._dispatch('headersReceived', details);
      } finally {
        callback({});
      }
    });

    wr.onBeforeRedirect(filter, (details) => {
      this._dispatch('beforeRedirect', details);
    });

    wr.onCompleted(filter, (details) => {
      this._dispatch('completed', details);
    });

    wr.onErrorOccurred(filter, (details) => {
      this._dispatch('error', details);
    });
  }

  register(webContentsId, recorder) {
    this.recorders.set(Number(webContentsId), recorder);
  }

  unregister(webContentsId, recorder) {
    const id = Number(webContentsId);
    if (!this.recorders.has(id)) return;
    if (recorder && this.recorders.get(id) !== recorder) return;
    this.recorders.delete(id);
  }

  _dispatch(stage, details) {
    const id = details.webContentsId ?? details.webContents?.id;
    if (!Number.isFinite(id)) return;
    const recorder = this.recorders.get(Number(id));
    if (!recorder?.recording) return;
    recorder.handleWebRequest(stage, details);
  }
}

module.exports = { NetworkTap };
