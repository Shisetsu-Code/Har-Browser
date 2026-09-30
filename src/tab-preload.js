'use strict';

const { ipcRenderer, webFrame } = require('electron');
const { buildRuntimePatch } = require('./runtime-patch');

function applyRuntime(speed = 1, keepActive = true) {
  return webFrame.executeJavaScript(
    buildRuntimePatch(speed, keepActive),
    true
  ).catch(() => {});
}

// This preload handles the top frame immediately. The main process also injects
// the same runtime into every iframe/OOPIF through WebFrameMain and CDP.
void applyRuntime(1, true);

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
