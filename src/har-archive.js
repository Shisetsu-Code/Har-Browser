'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_') || 'target';
  } catch {
    return 'target';
  }
}

function stableFileName(url, index) {
  const hash = crypto
    .createHash('sha1')
    .update(String(url))
    .digest('hex')
    .slice(0, 10);

  return `${String(index + 1).padStart(5, '0')}_${safeHost(url)}_${hash}.har`;
}

class HarArchiveManager {
  constructor(options) {
    this.statePath = options.statePath;
    this.outputDir = options.outputDir;
    this.captureTarget = options.captureTarget;
    this.onUpdate =
      typeof options.onUpdate === 'function'
        ? options.onUpdate
        : () => {};

    this.loopPromise = null;

    this.state = {
      version: 1,
      targets: [],
      completed: {},
      failed: {},
      running: false,
      currentUrl: '',
      currentIndex: -1,
      lastFile: ''
    };
  }

  async init() {
    await fs.mkdir(
      path.dirname(this.statePath),
      { recursive: true }
    );

    await fs.mkdir(
      this.outputDir,
      { recursive: true }
    );

    try {
      const parsed = JSON.parse(
        await fs.readFile(
          this.statePath,
          'utf8'
        )
      );

      if (parsed && typeof parsed === 'object') {
        this.state = {
          ...this.state,
          ...parsed,
          completed:
            parsed.completed &&
            typeof parsed.completed === 'object'
              ? parsed.completed
              : {},
          failed:
            parsed.failed &&
            typeof parsed.failed === 'object'
              ? parsed.failed
              : {},
          targets:
            Array.isArray(parsed.targets)
              ? parsed.targets
              : []
        };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn(
          '[HAR Browser] HAR archive state read failed:',
          error?.message || error
        );
      }
    }

    this.onUpdate();
    return this.getState();
  }

  getState() {
    const total = this.state.targets.length;

    let completed = 0;
    let failed = 0;

    for (const url of this.state.targets) {
      if (this.state.completed[url]) {
        completed += 1;
      } else if (this.state.failed[url]) {
        failed += 1;
      }
    }

    return {
      total,
      completed,
      failed,
      remaining:
        Math.max(
          0,
          total - completed - failed
        ),
      running: Boolean(this.state.running),
      currentUrl: this.state.currentUrl || '',
      currentIndex:
        Number.isInteger(this.state.currentIndex)
          ? this.state.currentIndex
          : -1,
      outputDir: this.outputDir,
      lastFile: this.state.lastFile || ''
    };
  }

  shouldResume() {
    return (
      this.state.running &&
      this._nextPendingIndex() >= 0
    );
  }

  async setTargets(targets) {
    const unique = [];
    const seen = new Set();

    for (const raw of targets || []) {
      const url = String(raw || '').trim();
      if (!url || seen.has(url)) continue;

      seen.add(url);
      unique.push(url);
    }

    this.state.targets = unique;

    const allowed = new Set(unique);

    for (const key of Object.keys(this.state.completed)) {
      if (!allowed.has(key)) {
        delete this.state.completed[key];
      }
    }

    for (const key of Object.keys(this.state.failed)) {
      if (!allowed.has(key)) {
        delete this.state.failed[key];
      }
    }

    await this._persist();
    this.onUpdate();

    return this.getState();
  }

  async start() {
    if (!this.state.targets.length) {
      return this.getState();
    }

    this.state.running = true;
    await this._persist();
    this.onUpdate();

    this._ensureLoop();
    return this.getState();
  }

  async pause() {
    this.state.running = false;
    await this._persist();
    this.onUpdate();
    return this.getState();
  }

  async retryFailed() {
    this.state.failed = {};
    await this._persist();
    this.onUpdate();

    if (this.state.running) {
      this._ensureLoop();
    }

    return this.getState();
  }

  async reset() {
    if (this.state.currentUrl) {
      return this.getState();
    }

    this.state.completed = {};
    this.state.failed = {};
    this.state.running = false;
    this.state.currentUrl = '';
    this.state.currentIndex = -1;
    this.state.lastFile = '';

    await this._persist();
    this.onUpdate();

    return this.getState();
  }

  _ensureLoop() {
    if (this.loopPromise) return;

    this.loopPromise = this._run()
      .catch((error) => {
        console.warn(
          '[HAR Browser] HAR archive loop failed:',
          error?.message || error
        );
      })
      .finally(() => {
        this.loopPromise = null;
        this.onUpdate();
      });
  }

  async _run() {
    while (this.state.running) {
      const index = this._nextPendingIndex();

      if (index < 0) {
        this.state.running = false;
        this.state.currentUrl = '';
        this.state.currentIndex = -1;
        await this._persist();
        this.onUpdate();
        break;
      }

      const url = this.state.targets[index];
      const fileName =
        stableFileName(url, index);

      const filePath = path.join(
        this.outputDir,
        fileName
      );

      // If the HAR already exists on disk, trust it and rebuild persistent
      // progress even if the JSON state was lost.
      try {
        const stat = await fs.stat(filePath);
        if (stat.isFile() && stat.size > 64) {
          this.state.completed[url] = {
            file: fileName,
            bytes: stat.size,
            savedAt: stat.mtime.toISOString()
          };

          delete this.state.failed[url];
          await this._persist();
          this.onUpdate();
          continue;
        }
      } catch {}

      this.state.currentUrl = url;
      this.state.currentIndex = index;
      await this._persist();
      this.onUpdate();

      try {
        const har =
          await this.captureTarget(
            url,
            index
          );

        const payload =
          JSON.stringify(har, null, 2);

        await fs.writeFile(
          filePath,
          payload,
          'utf8'
        );

        this.state.completed[url] = {
          file: fileName,
          bytes:
            Buffer.byteLength(
              payload,
              'utf8'
            ),
          savedAt:
            new Date().toISOString()
        };

        delete this.state.failed[url];
        this.state.lastFile = filePath;
      } catch (error) {
        this.state.failed[url] = {
          error:
            error?.message ||
            String(error),
          failedAt:
            new Date().toISOString()
        };
      }

      this.state.currentUrl = '';
      this.state.currentIndex = -1;

      await this._persist();
      this.onUpdate();

      // Intentionally serial: one game at a time.
      if (this.state.running) {
        await new Promise((resolve) =>
          setTimeout(resolve, 1200)
        );
      }
    }
  }

  _nextPendingIndex() {
    for (
      let index = 0;
      index < this.state.targets.length;
      index += 1
    ) {
      const url = this.state.targets[index];

      if (
        !this.state.completed[url] &&
        !this.state.failed[url]
      ) {
        return index;
      }
    }

    return -1;
  }

  async _persist() {
    const tmp = `${this.statePath}.tmp`;

    await fs.writeFile(
      tmp,
      JSON.stringify(
        this.state,
        null,
        2
      ),
      'utf8'
    );

    try {
      await fs.rename(
        tmp,
        this.statePath
      );
    } catch (error) {
      // Windows can reject rename-over-existing-file. Fall back to a replace
      // sequence while keeping the temp file complete on disk.
      if (
        error?.code !== 'EEXIST' &&
        error?.code !== 'EPERM'
      ) {
        throw error;
      }

      await fs.rm(
        this.statePath,
        { force: true }
      );

      await fs.rename(
        tmp,
        this.statePath
      );
    }
  }
}

module.exports = {
  HarArchiveManager,
  stableFileName
};
