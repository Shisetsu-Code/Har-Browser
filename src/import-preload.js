'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const allowed = new Set([
  'import:get-state',
  'import:choose-targets',
  'import:start',
  'import:pause',
  'import:load-one',
  'import:clear',
  'import:set-look-ahead',
  'hararchive:start',
  'hararchive:pause',
  'hararchive:retry-failed',
  'hararchive:reset',
  'hararchive:open-folder'
]);

contextBridge.exposeInMainWorld('targetImport', {
  invoke(channel, payload) {
    if (!allowed.has(channel)) {
      throw new Error(`IPC channel not allowed: ${channel}`);
    }

    return ipcRenderer.invoke(channel, payload);
  },

  onState(callback) {
    const listener = (_event, state) => callback(state);

    ipcRenderer.on('import:state', listener);

    return () =>
      ipcRenderer.removeListener(
        'import:state',
        listener
      );
  }
});
