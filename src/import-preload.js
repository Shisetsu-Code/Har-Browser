'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const allowed = new Set([
  'import:get-state',
  'import:choose-targets',
  'import:start',
  'import:pause',
  'import:next-batch',
  'import:clear',
  'import:set-batch-size'
]);

contextBridge.exposeInMainWorld('targetImport', {
  invoke(channel, payload) {
    if (!allowed.has(channel)) throw new Error(`IPC channel not allowed: ${channel}`);
    return ipcRenderer.invoke(channel, payload);
  },

  onState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('import:state', listener);
    return () => ipcRenderer.removeListener('import:state', listener);
  }
});
