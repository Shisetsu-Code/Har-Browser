'use strict';

function buildRuntimePatch(initialSpeed = 1, keepActive = true) {
  const speed = [1, 2, 4, 8].includes(Number(initialSpeed)) ? Number(initialSpeed) : 1;
  const active = Boolean(keepActive);

  return String.raw`
(() => {
  const INITIAL_SPEED = ${JSON.stringify(speed)};
  const INITIAL_KEEP_ACTIVE = ${JSON.stringify(active)};

  if (window.__HAR_BROWSER_RUNTIME_V2__) {
    window.__HAR_BROWSER_KEEP_ACTIVE__ = INITIAL_KEEP_ACTIVE;
    window.__HAR_BROWSER_SET_SPEED__?.(INITIAL_SPEED);
    return;
  }

  window.__HAR_BROWSER_RUNTIME_V2__ = true;
  window.__HAR_BROWSER_KEEP_ACTIVE__ = INITIAL_KEEP_ACTIVE;
  window.__HAR_BROWSER_SPEED__ = INITIAL_SPEED;

  const native = {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    requestAnimationFrame: window.requestAnimationFrame?.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame?.bind(window),
    performanceNow: performance.now.bind(performance),
    dateNow: Date.now.bind(Date)
  };

  let realAnchor = native.performanceNow();
  let virtualAnchor = realAnchor;
  const epochOffset = native.dateNow() - realAnchor;
  let rafOverrideNow = null;

  const timers = new Map();
  let nextTimerId = 1000000000;

  const rafCallbacks = new Map();
  let nextRafId = 1000000000;
  let nativeRafPending = false;
  let lastRafVirtual = virtualAnchor;

  function currentSpeed() {
    const value = Number(window.__HAR_BROWSER_SPEED__);
    return [1, 2, 4, 8].includes(value) ? value : 1;
  }

  function clockNow() {
    if (rafOverrideNow !== null) return rafOverrideNow;
    return virtualAnchor + (native.performanceNow() - realAnchor) * currentSpeed();
  }

  function rebase(nextSpeed) {
    const now = clockNow();
    realAnchor = native.performanceNow();
    virtualAnchor = now;
    window.__HAR_BROWSER_SPEED__ = nextSpeed;
  }

  function invokeCallback(callback, args) {
    if (typeof callback === 'function') {
      callback(...args);
      return;
    }
    (0, eval)(String(callback));
  }

  function scheduleTimer(record) {
    const remainingVirtual = Math.max(0, record.targetVirtual - clockNow());
    const realDelay = remainingVirtual / currentSpeed();

    record.nativeId = native.setTimeout(() => {
      if (!timers.has(record.id)) return;

      if (record.repeat) {
        record.targetVirtual += record.intervalVirtual;
      } else {
        timers.delete(record.id);
      }

      try {
        invokeCallback(record.callback, record.args);
      } finally {
        if (record.repeat && timers.has(record.id)) scheduleTimer(record);
      }
    }, realDelay);
  }

  function createTimer(callback, delay, repeat, args) {
    const intervalVirtual = Math.max(0, Number(delay) || 0);
    const id = nextTimerId++;
    const record = {
      id,
      callback,
      args,
      repeat,
      intervalVirtual,
      targetVirtual: clockNow() + intervalVirtual,
      nativeId: null
    };
    timers.set(id, record);
    scheduleTimer(record);
    return id;
  }

  function clearTimer(id) {
    const record = timers.get(Number(id));
    if (record) {
      native.clearTimeout(record.nativeId);
      timers.delete(record.id);
      return;
    }
    native.clearTimeout(id);
    native.clearInterval(id);
  }

  function pumpRaf() {
    nativeRafPending = false;
    if (!rafCallbacks.size || !native.requestAnimationFrame) return;

    const targetNow = clockNow();
    const cycles = currentSpeed();
    const start = Math.max(lastRafVirtual, targetNow - 16.6667 * cycles);
    const step = Math.max(0.01, (targetNow - start) / cycles);

    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      if (!rafCallbacks.size) break;

      const callbacks = [...rafCallbacks.entries()];
      rafCallbacks.clear();
      rafOverrideNow = start + step * cycle;
      lastRafVirtual = rafOverrideNow;

      for (const [, callback] of callbacks) {
        try {
          callback(rafOverrideNow);
        } catch (error) {
          native.setTimeout(() => { throw error; }, 0);
        }
      }
    }

    rafOverrideNow = null;
    if (rafCallbacks.size) ensureRaf();
  }

  function ensureRaf() {
    if (nativeRafPending || !native.requestAnimationFrame) return;
    nativeRafPending = true;
    native.requestAnimationFrame(pumpRaf);
  }

  function refreshAnimations(speedValue) {
    try {
      document.getAnimations({ subtree: true }).forEach((animation) => {
        try { animation.playbackRate = speedValue; } catch {}
      });
    } catch {}

    try {
      document.querySelectorAll('video').forEach((media) => {
        try { media.playbackRate = speedValue; } catch {}
      });
    } catch {}
  }

  function setSpeed(value) {
    const next = [1, 2, 4, 8].includes(Number(value)) ? Number(value) : 1;
    rebase(next);

    for (const record of timers.values()) {
      native.clearTimeout(record.nativeId);
      scheduleTimer(record);
    }

    refreshAnimations(next);
    window.dispatchEvent(new CustomEvent('harbrowser-speedchange', { detail: { speed: next } }));
    return next;
  }

  window.__HAR_BROWSER_SET_SPEED__ = setSpeed;
  window.__HAR_BROWSER_GET_SPEED__ = () => currentSpeed();

  try {
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => clockNow()
    });
  } catch {}

  try {
    Object.defineProperty(Date, 'now', {
      configurable: true,
      value: () => Math.floor(epochOffset + clockNow())
    });
  } catch {}

  window.setTimeout = (callback, delay = 0, ...args) =>
    createTimer(callback, delay, false, args);

  window.setInterval = (callback, delay = 0, ...args) =>
    createTimer(callback, delay, true, args);

  window.clearTimeout = clearTimer;
  window.clearInterval = clearTimer;

  if (native.requestAnimationFrame) {
    window.requestAnimationFrame = (callback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, callback);
      ensureRaf();
      return id;
    };

    window.cancelAnimationFrame = (id) => {
      rafCallbacks.delete(Number(id));
    };
  }

  const nativeAnimate = globalThis.Element?.prototype?.animate;
  if (nativeAnimate) {
    Element.prototype.animate = function acceleratedAnimate(...args) {
      const animation = nativeAnimate.apply(this, args);
      try { animation.playbackRate = currentSpeed(); } catch {}
      return animation;
    };
  }

  if (globalThis.document) {
    const nativeHasFocus = document.hasFocus ? document.hasFocus.bind(document) : () => true;
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');

    try {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get() {
          if (window.__HAR_BROWSER_KEEP_ACTIVE__) return false;
          return hiddenDescriptor?.get ? hiddenDescriptor.get.call(document) : false;
        }
      });
    } catch {}

    try {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get() {
          if (window.__HAR_BROWSER_KEEP_ACTIVE__) return 'visible';
          return visibilityDescriptor?.get ? visibilityDescriptor.get.call(document) : 'visible';
        }
      });
    } catch {}

    try {
      document.hasFocus = function hasFocus() {
        return window.__HAR_BROWSER_KEEP_ACTIVE__ ? true : nativeHasFocus();
      };
    } catch {}

    const suppressWhenPinned = (event) => {
      if (!window.__HAR_BROWSER_KEEP_ACTIVE__) return;
      event.stopImmediatePropagation();
    };

    document.addEventListener('visibilitychange', suppressWhenPinned, true);
    document.addEventListener('freeze', suppressWhenPinned, true);
    window.addEventListener('blur', suppressWhenPinned, true);

    native.setInterval(() => refreshAnimations(currentSpeed()), 100);
  }

  setSpeed(INITIAL_SPEED);
})();
`;
}

module.exports = { buildRuntimePatch };
