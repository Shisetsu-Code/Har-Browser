'use strict';

const { webFrame } = require('electron');

const keepActivePatch = String.raw`
(() => {
  if (window.__HAR_BROWSER_KEEP_ACTIVE_INSTALLED__) return;
  window.__HAR_BROWSER_KEEP_ACTIVE_INSTALLED__ = true;
  window.__HAR_BROWSER_KEEP_ACTIVE__ = true;

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

webFrame.executeJavaScript(keepActivePatch, true).catch(() => {});
