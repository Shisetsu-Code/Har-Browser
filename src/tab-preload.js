'use strict';

const { ipcRenderer, webFrame } = require('electron');

const runtimePatch = String.raw`
(() => {
  if (window.__HAR_BROWSER_RUNTIME_INSTALLED__) return;
  window.__HAR_BROWSER_RUNTIME_INSTALLED__ = true;
  window.__HAR_BROWSER_KEEP_ACTIVE__ = true;
  window.__HAR_BROWSER_SPEED__ = 1;

  const native = {
    setTimeout: window.setTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    requestAnimationFrame: window.requestAnimationFrame?.bind(window),
    performanceNow: performance.now.bind(performance)
  };

  const realPerfOrigin = native.performanceNow();
  let virtualPerfOrigin = realPerfOrigin;
  let speedAtOrigin = 1;

  function currentSpeed() {
    const value = Number(window.__HAR_BROWSER_SPEED__);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  function virtualNow() {
    const realNow = native.performanceNow();
    return virtualPerfOrigin + (realNow - realPerfOrigin) * speedAtOrigin;
  }

  function rebaseClock(nextSpeed) {
    const now = virtualNow();
    const realNow = native.performanceNow();
    virtualPerfOrigin = now;
    speedAtOrigin = nextSpeed;
    // realPerfOrigin is const, so fold the new real origin into virtual origin.
    virtualPerfOrigin -= (realNow - realPerfOrigin) * speedAtOrigin;
  }

  // Use a continuously derived virtual clock. Rebase by preserving continuity.
  let realAnchor = native.performanceNow();
  let virtualAnchor = realAnchor;

  function acceleratedNow() {
    return virtualAnchor + (native.performanceNow() - realAnchor) * currentSpeed();
  }

  function setSpeed(value) {
    const next = Math.max(0.25, Math.min(16, Number(value) || 1));
    const currentVirtual = acceleratedNow();
    realAnchor = native.performanceNow();
    virtualAnchor = currentVirtual;
    window.__HAR_BROWSER_SPEED__ = next;

    try {
      document.getAnimations({ subtree: true }).forEach((animation) => {
        try { animation.playbackRate = next; } catch {}
      });
    } catch {}
  }

  window.__HAR_BROWSER_SET_SPEED__ = setSpeed;

  try {
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: acceleratedNow
    });
  } catch {}

  window.setTimeout = function acceleratedSetTimeout(callback, delay = 0, ...args) {
    return native.setTimeout(callback, Math.max(0, Number(delay) || 0) / currentSpeed(), ...args);
  };

  window.setInterval = function acceleratedSetInterval(callback, delay = 0, ...args) {
    return native.setInterval(callback, Math.max(0, Number(delay) || 0) / currentSpeed(), ...args);
  };

  if (native.requestAnimationFrame) {
    window.requestAnimationFrame = function acceleratedRaf(callback) {
      return native.requestAnimationFrame(() => callback(acceleratedNow()));
    };
  }

  const nativeAnimate = Element.prototype.animate;
  if (nativeAnimate) {
    Element.prototype.animate = function acceleratedAnimate(...args) {
      const animation = nativeAnimate.apply(this, args);
      try { animation.playbackRate = currentSpeed(); } catch {}
      return animation;
    };
  }

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
})();
`;

webFrame.executeJavaScript(runtimePatch, true).catch(() => {});

ipcRenderer.on('har-browser:set-speed', (_event, speed) => {
  webFrame.executeJavaScript(
    `window.__HAR_BROWSER_SET_SPEED__?.(${JSON.stringify(speed)});`,
    true
  ).catch(() => {});
});

ipcRenderer.on('har-browser:set-keep-active', (_event, enabled) => {
  webFrame.executeJavaScript(
    `window.__HAR_BROWSER_KEEP_ACTIVE__ = ${enabled ? 'true' : 'false'};`,
    true
  ).catch(() => {});
});
