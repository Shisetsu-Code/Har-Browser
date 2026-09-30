'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  dialog,
  powerSaveBlocker,
  session
} = require('electron');
const { HarRecorder } = require('./har-recorder');
const { NetworkTap } = require('./network-tap');

const TOOLBAR_HEIGHT = 104;
const PARTITION = 'persist:har-browser';

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

let mainWindow;
let activeTabId = null;
let nextTabId = 1;
let suspensionBlocker = null;
let stateTimer = null;
let networkTap = null;
const tabs = new Map();
const smokeTest = process.argv.includes('--smoke-test');

function normalizeUrl(input) {
  const value = String(input || '').trim();
  if (!value) return 'about:blank';
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) return value;
  return `https://${value}`;
}

function safeFilename(url) {
  let host = 'capture';
  try {
    host = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_') || host;
  } catch {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${host}-${stamp}.har`;
}

function serializeTab(tab) {
  return {
    id: tab.id,
    title: tab.title || 'New Tab',
    url: tab.url || 'about:blank',
    keepActive: tab.keepActive,
    stats: tab.recorder?.getStats() || {
      recording: false,
      requests: 0,
      bytes: 0,
      wsFrames: 0
    }
  };
}

function getState() {
  return {
    activeTabId,
    tabs: [...tabs.values()].map(serializeTab)
  };
}

function sendStateNow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('browser:state', getState());
}

function scheduleState() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    sendStateNow();
  }, 80);
}

function layoutActiveTab() {
  if (!mainWindow || mainWindow.isDestroyed() || !activeTabId) return;
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  const [width, height] = mainWindow.getContentSize();
  tab.view.setBounds({
    x: 0,
    y: TOOLBAR_HEIGHT,
    width: Math.max(1, width),
    height: Math.max(1, height - TOOLBAR_HEIGHT)
  });
}

function wireTabEvents(tab) {
  const wc = tab.view.webContents;

  wc.setBackgroundThrottling(false);
  wc.setWindowOpenHandler(({ url }) => {
    createTab(url);
    return { action: 'deny' };
  });

  wc.on('page-title-updated', (_event, title) => {
    tab.title = title || tab.title;
    scheduleState();
  });

  const syncUrl = () => {
    tab.url = wc.getURL() || tab.url;
    tab.title = wc.getTitle() || tab.title;
    scheduleState();
  };

  wc.on('did-navigate', syncUrl);
  wc.on('did-navigate-in-page', syncUrl);
  wc.on('did-finish-load', syncUrl);
  wc.on('render-process-gone', (_event, details) => {
    tab.title = `Crashed: ${details.reason}`;
    scheduleState();
  });
}

function createTab(url = 'about:blank') {
  if (!mainWindow) return null;

  const id = nextTabId++;
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'tab-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  const tab = {
    id,
    view,
    recorder: null,
    title: 'New Tab',
    url: normalizeUrl(url),
    keepActive: true
  };

  tabs.set(id, tab);
  wireTabEvents(tab);
  activateTab(id);
  view.webContents.loadURL(tab.url).catch(() => {});
  scheduleState();
  return tab;
}

function activateTab(id) {
  const tab = tabs.get(Number(id));
  if (!tab || !mainWindow) return false;

  if (activeTabId && tabs.has(activeTabId)) {
    const old = tabs.get(activeTabId);
    try {
      mainWindow.contentView.removeChildView(old.view);
    } catch {}
  }

  activeTabId = tab.id;
  mainWindow.contentView.addChildView(tab.view);
  layoutActiveTab();
  tab.view.webContents.focus();
  scheduleState();
  return true;
}

async function closeTab(id) {
  const numericId = Number(id);
  const tab = tabs.get(numericId);
  if (!tab) return false;

  if (tab.recorder?.recording) {
    await tab.recorder.stop();
  }

  if (activeTabId === numericId) {
    try {
      mainWindow.contentView.removeChildView(tab.view);
    } catch {}
  }

  tab.view.webContents.close();
  tabs.delete(numericId);

  if (tabs.size === 0) {
    activeTabId = null;
    createTab();
  } else if (activeTabId === numericId) {
    activateTab([...tabs.keys()][tabs.size - 1]);
  }

  scheduleState();
  return true;
}

function activeTab() {
  return tabs.get(activeTabId) || null;
}

async function setKeepActive(tab, enabled) {
  tab.keepActive = Boolean(enabled);
  tab.view.webContents.setBackgroundThrottling(!tab.keepActive ? true : false);
  await tab.view.webContents.executeJavaScript(
    `window.__HAR_BROWSER_KEEP_ACTIVE__ = ${tab.keepActive ? 'true' : 'false'};`,
    true
  ).catch(() => {});
  scheduleState();
}

async function startRecording(tab, reload) {
  if (tab.recorder?.recording) return { ok: true };

  tab.recorder = new HarRecorder(tab.view.webContents, {
    networkTap,
    onUpdate: scheduleState
  });

  try {
    await tab.recorder.start();
    if (reload) tab.view.webContents.reloadIgnoringCache();
    scheduleState();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function stopAndSave(tab) {
  if (!tab.recorder?.recording) return { ok: false, error: 'No active capture' };

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save HAR capture',
    defaultPath: path.join(app.getPath('downloads'), safeFilename(tab.url)),
    filters: [{ name: 'HTTP Archive', extensions: ['har'] }],
    properties: ['showOverwriteConfirmation']
  });

  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }

  const har = await tab.recorder.stop();
  await fs.writeFile(result.filePath, JSON.stringify(har, null, 2), 'utf8');
  scheduleState();
  return {
    ok: true,
    path: result.filePath,
    stats: tab.recorder.getStats()
  };
}

function registerIpc() {
  ipcMain.handle('browser:get-state', () => getState());

  ipcMain.handle('tab:new', (_event, payload) => {
    const tab = createTab(payload?.url || 'about:blank');
    return tab ? serializeTab(tab) : null;
  });

  ipcMain.handle('tab:activate', (_event, payload) => activateTab(payload?.id));

  ipcMain.handle('tab:close', async (_event, payload) => closeTab(payload?.id));

  ipcMain.handle('tab:navigate', async (_event, payload) => {
    const tab = activeTab();
    if (!tab) return false;
    tab.url = normalizeUrl(payload?.url);
    await tab.view.webContents.loadURL(tab.url).catch(() => {});
    scheduleState();
    return true;
  });

  ipcMain.handle('tab:back', () => {
    const tab = activeTab();
    if (tab?.view.webContents.navigationHistory.canGoBack()) {
      tab.view.webContents.navigationHistory.goBack();
    }
  });

  ipcMain.handle('tab:forward', () => {
    const tab = activeTab();
    if (tab?.view.webContents.navigationHistory.canGoForward()) {
      tab.view.webContents.navigationHistory.goForward();
    }
  });

  ipcMain.handle('tab:reload', (_event, payload) => {
    const tab = activeTab();
    if (!tab) return;
    if (payload?.ignoreCache) tab.view.webContents.reloadIgnoringCache();
    else tab.view.webContents.reload();
  });

  ipcMain.handle('tab:toggle-keep-active', async () => {
    const tab = activeTab();
    if (!tab) return false;
    await setKeepActive(tab, !tab.keepActive);
    return tab.keepActive;
  });

  ipcMain.handle('har:start', async (_event, payload) => {
    const tab = activeTab();
    if (!tab) return { ok: false, error: 'No active tab' };
    return startRecording(tab, Boolean(payload?.reload));
  });

  ipcMain.handle('har:stop-save', async () => {
    const tab = activeTab();
    if (!tab) return { ok: false, error: 'No active tab' };
    try {
      return await stopAndSave(tab);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#101214',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  mainWindow.webContents.setBackgroundThrottling(false);
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWindow.on('resize', layoutActiveTab);

  mainWindow.on('closed', () => {
    for (const tab of tabs.values()) {
      try {
        tab.view.webContents.close();
      } catch {}
    }
    tabs.clear();
    mainWindow = null;
  });

  mainWindow.webContents.once('did-finish-load', () => {
    createTab();
    sendStateNow();

    if (smokeTest) {
      setTimeout(() => {
        console.log('HAR_BROWSER_SMOKE_OK');
        app.quit();
      }, 750);
    }
  });
}

app.whenReady().then(() => {
  suspensionBlocker = powerSaveBlocker.start('prevent-app-suspension');
  networkTap = new NetworkTap(session.fromPartition(PARTITION));
  networkTap.install();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (suspensionBlocker !== null && powerSaveBlocker.isStarted(suspensionBlocker)) {
    powerSaveBlocker.stop(suspensionBlocker);
  }
  if (process.platform !== 'darwin') app.quit();
});
