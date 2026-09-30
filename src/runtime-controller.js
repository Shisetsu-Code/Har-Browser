'use strict';

const { buildRuntimePatch } = require('./runtime-patch');

class RuntimeController {
  constructor(webContents, getState, onUpdate = () => {}) {
    this.webContents = webContents;
    this.getState = getState;
    this.onUpdate = onUpdate;
    this.sessions = new Set();
    this.scriptIds = new Map();
    this.started = false;
    this.attachedDebugger = false;
    this.lastAppliedTargets = 0;

    this._messageListener = (_event, method, params, sessionId) => {
      Promise.resolve(
        this._onMessage(method, params, sessionId)
      ).catch(() => {});
    };
  }

  _state() {
    const state = this.getState?.() || {};
    return {
      speed: [1, 2, 4, 8].includes(Number(state.speed)) ? Number(state.speed) : 1,
      keepActive: state.keepActive !== false
    };
  }

  _source() {
    const { speed, keepActive } = this._state();
    return buildRuntimePatch(speed, keepActive);
  }

  _alive() {
    try {
      return Boolean(
        this.webContents &&
        !this.webContents.isDestroyed()
      );
    } catch {
      return false;
    }
  }

  _debugger() {
    if (!this._alive()) return null;

    try {
      return this.webContents.debugger || null;
    } catch {
      return null;
    }
  }

  async start() {
    if (this.started || !this._alive()) return;
    this.started = true;

    const dbg = this._debugger();
    if (!dbg) {
      this.started = false;
      return;
    }

    try {
      if (!dbg.isAttached()) {
        dbg.attach();
        this.attachedDebugger = true;
      }

      dbg.on('message', this._messageListener);

      await this._installInSession(null);

      await dbg.sendCommand('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true
      }).catch(() => {});

      this.onUpdate();
    } catch {
      // WebFrameMain injection in main.js remains the fallback.
    }
  }

  async stop() {
    if (!this.started) return;
    this.started = false;

    const dbg = this._debugger();
    if (dbg) {
      try {
        dbg.removeListener('message', this._messageListener);
      } catch {}
    }

    // Do not detach here. HarRecorder may share this debugger connection.
    this.sessions.clear();
    this.scriptIds.clear();
  }

  async refresh() {
    if (!this.started || !this._alive()) return 0;

    const targets = [null, ...this.sessions];
    let applied = 0;

    for (const sessionId of targets) {
      const ok = await this._installInSession(sessionId, true);
      if (ok) applied += 1;
    }

    this.lastAppliedTargets = applied;
    this.onUpdate();
    return applied;
  }

  async _onMessage(method, params) {
    if (!this.started) return;

    if (method === 'Target.attachedToTarget') {
      const childSessionId = params?.sessionId;
      if (!childSessionId) return;

      this.sessions.add(childSessionId);

      const dbg = this._debugger();
      if (!dbg) return;

      await dbg.sendCommand('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true
      }, childSessionId).catch(() => {});

      await this._installInSession(childSessionId);
      this.onUpdate();
      return;
    }

    if (method === 'Target.detachedFromTarget') {
      const childSessionId = params?.sessionId;
      if (!childSessionId) return;
      this.sessions.delete(childSessionId);
      this.scriptIds.delete(childSessionId);
      this.onUpdate();
    }
  }

  async _installInSession(sessionId, replaceExisting = false) {
    if (!this._alive()) return false;

    const dbg = this._debugger();
    if (!dbg) return false;
    const key = sessionId || 'root';
    const source = this._source();

    if (replaceExisting) {
      const previousId = this.scriptIds.get(key);
      if (previousId) {
        await dbg.sendCommand(
          'Page.removeScriptToEvaluateOnNewDocument',
          { identifier: previousId },
          sessionId || undefined
        ).catch(() => {});
        this.scriptIds.delete(key);
      }
    }

    let installed = false;

    try {
      const result = await dbg.sendCommand(
        'Page.addScriptToEvaluateOnNewDocument',
        {
          source,
          runImmediately: true
        },
        sessionId || undefined
      );

      if (result?.identifier) this.scriptIds.set(key, result.identifier);
      installed = true;
    } catch {
      // Worker-like targets do not expose the Page domain.
    }

    try {
      await dbg.sendCommand(
        'Runtime.evaluate',
        {
          expression: source,
          silent: true,
          allowUnsafeEvalBlockedByCSP: true
        },
        sessionId || undefined
      );
      installed = true;
    } catch {
      // Some non-page targets cannot evaluate a window-based runtime patch.
    }

    return installed;
  }
}

module.exports = { RuntimeController };
