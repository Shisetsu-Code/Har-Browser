'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const allowed = new Set([
  'browser:get-state',
  'tab:new',
  'tab:activate',
  'tab:close',
  'tab:navigate',
  'tab:back',
  'tab:forward',
  'tab:reload',
  'tab:toggle-keep-active',
  'tab:set-speed',
  'tab:toggle-mute',
  'tab:toggle-game-only',
  'har:start',
  'har:stop-save'
]);

contextBridge.exposeInMainWorld('harBrowser', {
  invoke(channel, payload) {
    if (!allowed.has(channel)) throw new Error(`IPC channel not allowed: ${channel}`);
    return ipcRenderer.invoke(channel, payload);
  },
  onState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('browser:state', listener);
    return () => ipcRenderer.removeListener('browser:state', listener);
  }
});
