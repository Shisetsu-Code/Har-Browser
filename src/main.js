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
  session,
  Menu
} = require('electron');

const { HarRecorder } = require('./har-recorder');
const { NetworkTap } = require('./network-tap');
const { RuntimeController } = require('./runtime-controller');
const { buildRuntimePatch } = require('./runtime-patch');
const { parseTargets } = require('./target-import');

const TOOLBAR_HEIGHT = 68;
const PARTITION = 'persist:har-browser';
const IMPORT_BATCH_COOLDOWN_MS = 1500;
const IMPORT_STAGGER_MS = 250;
const IMPORT_LOAD_TIMEOUT_MS = 15000;

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch(
  'disable-features',
  'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling'
);
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

let mainWindow;
let activeTabId = null;
let importTabId = null;
let nextTabId = 1;
let suspensionBlocker = null;
let stateTimer = null;
let networkTap = null;
let importLoopPromise = null;

const tabs = new Map();
const smokeTest = process.argv.includes('--smoke-test');

const importQueue = {
  targets: [],
  nextIndex: 0,
  opened: 0,
  running: false,
  loading: false,
  batchSize: 6,
  currentBatch: 0,
  filePath: '',
  errors: 0
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    kind: tab.kind || 'game',
    closable: tab.kind !== 'import',
    title: tab.title || (tab.kind === 'import' ? 'IMPORT' : 'New Tab'),
    url: tab.url || 'about:blank',
    keepActive: tab.keepActive,
    speed: tab.speed,
    muted: tab.muted,
    gameOnly: tab.gameOnly,
    runtimeFrames: tab.runtimeFrames || 0,
    runtimeTargets: tab.runtimeController?.lastAppliedTargets || 0,
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
  }, 60);
}

function getImportState() {
  return {
    total: importQueue.targets.length,
    opened: importQueue.opened,
    remaining: Math.max(0, importQueue.targets.length - importQueue.nextIndex),
    running: importQueue.running,
    loading: importQueue.loading,
    batchSize: importQueue.batchSize,
    currentBatch: importQueue.currentBatch,
    filePath: importQueue.filePath,
    errors: importQueue.errors
  };
}

function notifyImportState() {
  const tab = tabs.get(importTabId);
  if (!tab || tab.view.webContents.isDestroyed()) return;

  tab.view.webContents.send('import:state', getImportState());
}

function layoutTabs() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const [width, height] = mainWindow.getContentSize();
  const bounds = {
    x: 0,
    y: TOOLBAR_HEIGHT,
    width: Math.max(1, width),
    height: Math.max(1, height - TOOLBAR_HEIGHT)
  };

  for (const tab of tabs.values()) {
    try {
      tab.view.setVisible(true);
      tab.view.setBounds(bounds);
    } catch {}
  }
}

function attachBackgroundView(tab) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  try {
    mainWindow.contentView.addChildView(tab.view);
    tab.view.setVisible(true);
  } catch {}

  layoutTabs();

  const active = tabs.get(activeTabId);
  if (active && active.id !== tab.id) {
    try {
      mainWindow.contentView.addChildView(active.view);
    } catch {}
  }
}

function normalizeSpeed(value) {
  const speed = Number(value);
  return [1, 2, 4, 8].includes(speed) ? speed : 1;
}

async function injectFrameRuntime(tab, frame) {
  if (!frame || frame.isDestroyed?.()) return false;

  try {
    await frame.executeJavaScript(buildRuntimePatch(tab.speed, tab.keepActive), true);
    return true;
  } catch {
    return false;
  }
}

async function applyRuntimeToFrames(tab) {
  if (tab.kind !== 'game') return 0;

  const wc = tab.view.webContents;
  if (wc.isDestroyed()) return 0;

  let frames = [];
  try {
    frames = wc.mainFrame?.framesInSubtree || [];
  } catch {}

  let applied = 0;
  for (const frame of frames) {
    if (await injectFrameRuntime(tab, frame)) applied += 1;
  }

  tab.runtimeFrames = applied;
  scheduleState();
  return applied;
}

async function applyTabRuntime(tab) {
  if (tab.kind !== 'game') return { frames: 0, targets: 0 };

  const wc = tab.view.webContents;
  if (wc.isDestroyed()) return { frames: 0, targets: 0 };

  wc.setAudioMuted(tab.muted);
  wc.send('har-browser:set-speed', tab.speed);
  wc.send('har-browser:set-keep-active', tab.keepActive);

  const [frames, targets] = await Promise.all([
    applyRuntimeToFrames(tab),
    tab.runtimeController?.refresh?.() || Promise.resolve(0)
  ]);

  return { frames, targets };
}

function makeInitialLoadPromise(webContents, timeoutMs = IMPORT_LOAD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      webContents.removeListener('did-finish-load', onFinish);
      webContents.removeListener('did-fail-load', onFail);
      resolve(result);
    };

    const onFinish = () => finish({ ok: true });
    const onFail = (_event, errorCode, errorDescription) =>
      finish({ ok: false, errorCode, errorDescription });

    const timer = setTimeout(
      () => finish({ ok: false, timeout: true }),
      timeoutMs
    );

    webContents.once('did-finish-load', onFinish);
    webContents.once('did-fail-load', onFail);
  });
}

function handleShortcut(event, input) {
  if (input.type !== 'keyDown' || !input.control) return;

  const key = String(input.key || '').toLowerCase();

  if (key === 't' && !input.shift) {
    event.preventDefault();
    createTab();
    return;
  }

  if (key === 'tab') {
    event.preventDefault();
    cycleGameTab(input.shift ? -1 : 1);
    return;
  }

  if (key === 'w' && !input.shift) {
    const tab = tabs.get(activeTabId);
    if (!tab || tab.kind !== 'game') return;

    event.preventDefault();
    void closeTab(tab.id);
  }
}

function wireShortcutCapture(webContents) {
  webContents.on('before-input-event', handleShortcut);
}

function wireGameTabEvents(tab) {
  const wc = tab.view.webContents;

  wc.setBackgroundThrottling(false);
  wc.setAudioMuted(tab.muted);
  wireShortcutCapture(wc);

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

  wc.on('frame-created', (_event, details) => {
    const frame = details?.frame;
    if (!frame) return;

    const apply = () => {
      void injectFrameRuntime(tab, frame).then((ok) => {
        if (!ok) return;

        try {
          tab.runtimeFrames =
            wc.mainFrame?.framesInSubtree?.length ||
            tab.runtimeFrames ||
            1;
        } catch {}

        scheduleState();
      });
    };

    frame.on?.('dom-ready', apply);
    apply();
  });

  wc.on('did-frame-navigate', () => {
    void applyRuntimeToFrames(tab);
  });

  wc.on('did-finish-load', () => {
    syncUrl();
    void applyTabRuntime(tab);
  });

  wc.on('render-process-gone', (_event, details) => {
    tab.title = `Crashed: ${details.reason}`;
    scheduleState();
  });
}

function createTab(url = 'about:blank', options = {}) {
  if (!mainWindow) return null;

  const shouldActivate = options.activate !== false;
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
    kind: 'game',
    view,
    recorder: null,
    title: 'New Tab',
    url: normalizeUrl(url),
    keepActive: true,
    speed: 1,
    muted: true,
    gameOnly: true,
    runtimeFrames: 0,
    runtimeController: null,
    initialLoadPromise: makeInitialLoadPromise(view.webContents)
  };

  tabs.set(id, tab);
  wireGameTabEvents(tab);

  tab.runtimeController = new RuntimeController(
    view.webContents,
    () => ({ speed: tab.speed, keepActive: tab.keepActive }),
    scheduleState
  );

  if (shouldActivate) {
    activateTab(id);
  } else {
    attachBackgroundView(tab);
  }

  void tab.runtimeController.start()
    .catch(() => {})
    .finally(() => {
      if (!view.webContents.isDestroyed()) {
        view.webContents.loadURL(tab.url).catch(() => {});
      }
    });

  scheduleState();
  return tab;
}

function createImportTab() {
  if (importTabId && tabs.has(importTabId)) return tabs.get(importTabId);
  if (!mainWindow) return null;

  const id = nextTabId++;
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'import-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  const tab = {
    id,
    kind: 'import',
    view,
    recorder: null,
    title: 'IMPORT',
    url: 'har-browser://import',
    keepActive: true,
    speed: 1,
    muted: true,
    gameOnly: false,
    runtimeFrames: 0,
    runtimeController: null
  };

  importTabId = id;
  tabs.set(id, tab);

  view.webContents.setBackgroundThrottling(false);
  wireShortcutCapture(view.webContents);
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  view.webContents.on('did-finish-load', () => {
    notifyImportState();
  });

  attachBackgroundView(tab);
  view.webContents
    .loadFile(path.join(__dirname, 'import', 'index.html'))
    .catch(() => {});

  scheduleState();
  return tab;
}

function activateTab(id) {
  const tab = tabs.get(Number(id));
  if (!tab || !mainWindow) return false;

  activeTabId = tab.id;

  try {
    mainWindow.contentView.addChildView(tab.view);
    tab.view.setVisible(true);
  } catch {}

  layoutTabs();
  tab.view.webContents.focus();
  scheduleState();
  return true;
}

function cycleGameTab(direction = 1) {
  const gameTabs = [...tabs.values()].filter((tab) => tab.kind === 'game');
  if (!gameTabs.length) return false;

  let index = gameTabs.findIndex((tab) => tab.id === activeTabId);

  if (index < 0) {
    index = direction > 0 ? -1 : 0;
  }

  const nextIndex =
    (index + direction + gameTabs.length) % gameTabs.length;

  return activateTab(gameTabs[nextIndex].id);
}

async function closeTab(id) {
  const numericId = Number(id);
  const tab = tabs.get(numericId);
  if (!tab || tab.kind === 'import') return false;

  if (tab.recorder?.recording) {
    await tab.recorder.stop();
  }

  await tab.runtimeController?.stop?.();

  try {
    mainWindow.contentView.removeChildView(tab.view);
  } catch {}

  tab.view.webContents.close();
  tabs.delete(numericId);

  if (activeTabId === numericId) {
    const games = [...tabs.values()].filter((candidate) => candidate.kind === 'game');

    if (games.length) {
      activateTab(games[Math.max(0, games.length - 1)].id);
    } else {
      const newTab = createTab();
      if (!newTab && importTabId) activateTab(importTabId);
    }
  }

  scheduleState();
  return true;
}

function activeTab() {
  return tabs.get(activeTabId) || null;
}

async function setKeepActive(tab, enabled) {
  if (!tab || tab.kind !== 'game') return false;

  tab.keepActive = Boolean(enabled);
  tab.view.webContents.setBackgroundThrottling(!tab.keepActive);
  await applyTabRuntime(tab);
  scheduleState();
  return tab.keepActive;
}

async function startRecording(tab, reload) {
  if (!tab || tab.kind !== 'game') {
    return { ok: false, error: 'Select a game tab first' };
  }

  if (tab.recorder?.recording) return { ok: true };

  tab.recorder = new HarRecorder(tab.view.webContents, {
    networkTap,
    gameOnly: tab.gameOnly,
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
  if (!tab || tab.kind !== 'game') {
    return { ok: false, error: 'Select a game tab first' };
  }

  if (!tab.recorder?.recording) {
    return { ok: false, error: 'No active capture' };
  }

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save HAR capture',
    defaultPath: path.join(
      app.getPath('downloads'),
      safeFilename(tab.url)
    ),
    filters: [{ name: 'HTTP Archive', extensions: ['har'] }],
    properties: ['showOverwriteConfirmation']
  });

  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }

  const har = await tab.recorder.stop();
  await fs.writeFile(
    result.filePath,
    JSON.stringify(har, null, 2),
    'utf8'
  );

  scheduleState();

  return {
    ok: true,
    path: result.filePath,
    stats: tab.recorder.getStats()
  };
}

async function chooseTargetsFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Load targets.txt',
    properties: ['openFile'],
    filters: [
      { name: 'Target lists', extensions: ['txt'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePaths?.[0]) {
    return getImportState();
  }

  const filePath = result.filePaths[0];
  const text = await fs.readFile(filePath, 'utf8');
  const targets = parseTargets(text);

  importQueue.targets = targets;
  importQueue.nextIndex = 0;
  importQueue.opened = 0;
  importQueue.running = false;
  importQueue.loading = false;
  importQueue.currentBatch = 0;
  importQueue.filePath = filePath;
  importQueue.errors = 0;

  notifyImportState();
  return getImportState();
}

async function loadNextImportBatch() {
  const state = getImportState();
  if (importQueue.loading || state.remaining <= 0) return state;

  const count = Math.min(importQueue.batchSize, state.remaining);
  const urls = importQueue.targets.slice(
    importQueue.nextIndex,
    importQueue.nextIndex + count
  );

  importQueue.loading = true;
  importQueue.currentBatch = urls.length;
  importQueue.nextIndex += urls.length;
  notifyImportState();

  const previousActiveId = activeTabId;
  const created = [];

  for (const url of urls) {
    try {
      const tab = createTab(url, { activate: false });
      if (tab) {
        created.push(tab);
        importQueue.opened += 1;
      } else {
        importQueue.errors += 1;
      }
    } catch {
      importQueue.errors += 1;
    }

    notifyImportState();

    if (url !== urls[urls.length - 1]) {
      await delay(IMPORT_STAGGER_MS);
    }
  }

  if (previousActiveId && tabs.has(previousActiveId)) {
    activateTab(previousActiveId);
  }

  await Promise.allSettled(
    created
      .map((tab) => tab.initialLoadPromise)
      .filter(Boolean)
  );

  importQueue.loading = false;
  importQueue.currentBatch = 0;
  notifyImportState();

  return getImportState();
}

function startImportQueue() {
  if (importQueue.running || importLoopPromise) return getImportState();
  if (getImportState().remaining <= 0) return getImportState();

  importQueue.running = true;
  notifyImportState();

  importLoopPromise = (async () => {
    try {
      while (importQueue.running && getImportState().remaining > 0) {
        await loadNextImportBatch();

        if (
          importQueue.running &&
          getImportState().remaining > 0
        ) {
          await delay(IMPORT_BATCH_COOLDOWN_MS);
        }
      }
    } finally {
      importQueue.running = false;
      importLoopPromise = null;
      notifyImportState();
    }
  })();

  return getImportState();
}

function pauseImportQueue() {
  importQueue.running = false;
  notifyImportState();
  return getImportState();
}

function clearImportQueue() {
  if (importQueue.running || importQueue.loading) {
    return getImportState();
  }

  importQueue.targets = [];
  importQueue.nextIndex = 0;
  importQueue.opened = 0;
  importQueue.currentBatch = 0;
  importQueue.filePath = '';
  importQueue.errors = 0;

  notifyImportState();
  return getImportState();
}

function registerIpc() {
  ipcMain.handle('browser:get-state', () => getState());

  ipcMain.handle('tab:new', (_event, payload) => {
    const tab = createTab(payload?.url || 'about:blank');
    return tab ? serializeTab(tab) : null;
  });

  ipcMain.handle(
    'tab:activate',
    (_event, payload) => activateTab(payload?.id)
  );

  ipcMain.handle(
    'tab:close',
    async (_event, payload) => closeTab(payload?.id)
  );

  ipcMain.handle('tab:navigate', async (_event, payload) => {
    const tab = activeTab();
    if (!tab || tab.kind !== 'game') return false;

    tab.url = normalizeUrl(payload?.url);
    await tab.view.webContents.loadURL(tab.url).catch(() => {});
    scheduleState();
    return true;
  });

  ipcMain.handle('tab:back', () => {
    const tab = activeTab();
    if (
      tab?.kind === 'game' &&
      tab.view.webContents.navigationHistory.canGoBack()
    ) {
      tab.view.webContents.navigationHistory.goBack();
    }
  });

  ipcMain.handle('tab:forward', () => {
    const tab = activeTab();
    if (
      tab?.kind === 'game' &&
      tab.view.webContents.navigationHistory.canGoForward()
    ) {
      tab.view.webContents.navigationHistory.goForward();
    }
  });

  ipcMain.handle('tab:reload', (_event, payload) => {
    const tab = activeTab();
    if (!tab || tab.kind !== 'game') return;

    if (payload?.ignoreCache) {
      tab.view.webContents.reloadIgnoringCache();
    } else {
      tab.view.webContents.reload();
    }
  });

  ipcMain.handle('tab:toggle-keep-active', async () => {
    const tab = activeTab();
    if (!tab || tab.kind !== 'game') return false;
    return setKeepActive(tab, !tab.keepActive);
  });

  ipcMain.handle('tab:set-speed', async (_event, payload) => {
    const tab = activeTab();
    if (!tab || tab.kind !== 'game') {
      return { speed: 1, frames: 0, targets: 0 };
    }

    tab.speed = normalizeSpeed(payload?.speed);
    const applied = await applyTabRuntime(tab);
    scheduleState();

    return {
      speed: tab.speed,
      frames: applied.frames,
      targets: applied.targets
    };
  });

  ipcMain.handle('tab:toggle-mute', () => {
    const tab = activeTab();
    if (!tab || tab.kind !== 'game') return true;

    tab.muted = !tab.muted;
    tab.view.webContents.setAudioMuted(tab.muted);
    scheduleState();
    return tab.muted;
  });

  ipcMain.handle('tab:toggle-game-only', () => {
    const tab = activeTab();
    if (!tab || tab.kind !== 'game') return true;

    tab.gameOnly = !tab.gameOnly;
    tab.recorder?.setGameOnly(tab.gameOnly);
    scheduleState();
    return tab.gameOnly;
  });

  ipcMain.handle('har:start', async (_event, payload) => {
    return startRecording(activeTab(), Boolean(payload?.reload));
  });

  ipcMain.handle('har:stop-save', async () => {
    try {
      return await stopAndSave(activeTab());
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('import:get-state', () => getImportState());

  ipcMain.handle('import:choose-targets', async () => {
    try {
      return await chooseTargetsFile();
    } catch (error) {
      return {
        ...getImportState(),
        error: error.message
      };
    }
  });

  ipcMain.handle('import:start', () => startImportQueue());

  ipcMain.handle('import:pause', () => pauseImportQueue());

  ipcMain.handle('import:next-batch', async () => {
    if (importQueue.running) return getImportState();
    return loadNextImportBatch();
  });

  ipcMain.handle('import:clear', () => clearImportQueue());

  ipcMain.handle('import:set-batch-size', (_event, payload) => {
    const size = Number(payload?.batchSize);
    importQueue.batchSize = size === 5 ? 5 : 6;
    notifyImportState();
    return getImportState();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: '#101214',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setBackgroundThrottling(false);
  wireShortcutCapture(mainWindow.webContents);

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWindow.on('resize', layoutTabs);

  mainWindow.on('closed', () => {
    importQueue.running = false;

    for (const tab of tabs.values()) {
      try {
        tab.view.webContents.close();
      } catch {}
    }

    tabs.clear();
    mainWindow = null;
  });

  mainWindow.webContents.once('did-finish-load', () => {
    createImportTab();
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
  Menu.setApplicationMenu(null);

  suspensionBlocker = powerSaveBlocker.start(
    'prevent-app-suspension'
  );

  networkTap = new NetworkTap(session.fromPartition(PARTITION));
  networkTap.install();

  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  importQueue.running = false;

  if (
    suspensionBlocker !== null &&
    powerSaveBlocker.isStarted(suspensionBlocker)
  ) {
    powerSaveBlocker.stop(suspensionBlocker);
  }

  if (process.platform !== 'darwin') app.quit();
});
