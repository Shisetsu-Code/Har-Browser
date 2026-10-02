'use strict';

const el = (id) => document.getElementById(id);

const tabsEl = el('tabs');
const addressEl = el('address');
const statusEl = el('status');
const statsEl = el('stats');
const recordEl = el('record');
const stopSaveEl = el('stopSave');
const speedEl = el('speed');
const backEl = el('back');
const forwardEl = el('forward');
const reloadEl = el('reload');
const goEl = el('go');

let state = { tabs: [], activeTabId: null };

function activeTab() {
  return state.tabs.find((tab) => tab.id === state.activeTabId) || null;
}

function humanBytes(bytes) {
  if (!bytes) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function setStatus(message) {
  statusEl.textContent = message;
}

function render() {
  tabsEl.replaceChildren();

  for (const tab of state.tabs) {
    const tabButton = document.createElement('button');
    tabButton.className = [
      'tab',
      tab.id === state.activeTabId ? 'active' : '',
      tab.stats?.recording ? 'recording' : '',
      tab.loadState === 'loading' ? 'loading' : '',
      tab.loadState === 'failed' ? 'failed' : '',
      tab.kind === 'import' ? 'import-tab' : ''
    ].filter(Boolean).join(' ');

    tabButton.dataset.id = String(tab.id);

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent =
      tab.kind === 'import'
        ? 'IMPORT'
        : (tab.title || tab.url || 'New Tab');

    tabButton.append(title);

    if (tab.closable !== false) {
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = 'Close tab';
      tabButton.append(close);
    }

    tabsEl.append(tabButton);
  }

  const tab = activeTab();
  if (!tab) return;

  const isGame = tab.kind === 'game';
  const recording = isGame && Boolean(tab.stats?.recording);

  addressEl.disabled = !isGame;
  backEl.disabled = !isGame;
  forwardEl.disabled = !isGame;
  reloadEl.disabled = !isGame;
  goEl.disabled = !isGame;
  speedEl.disabled = !isGame;
  recordEl.disabled = !isGame || recording;
  stopSaveEl.disabled = !recording;

  if (document.activeElement !== addressEl) {
    addressEl.value = isGame
      ? (tab.url === 'about:blank' ? '' : tab.url)
      : 'targets.txt import queue';
  }

  speedEl.value = String(tab.speed || 1);
  recordEl.classList.toggle('recording', recording);

  if (isGame) {
    const loadLabel =
      tab.loadState === 'loading'
        ? 'LOADING'
        : tab.loadState === 'failed'
          ? 'FAILED'
          : tab.loadState === 'loaded'
            ? 'READY'
            : 'IDLE';

    const wsLabel =
      tab.stats?.wsFrames
        ? ` · WS ${tab.stats.wsFrames}/${tab.stats.wsSpins || 0} spins`
        : '';

    statsEl.textContent =
      `${loadLabel} · ${tab.stats?.requests || 0} req · ${humanBytes(tab.stats?.bytes || 0)}${wsLabel} · ${tab.runtimeFrames || 0}F/${tab.runtimeTargets || 0}T`;

    if (tab.loadState === 'failed') {
      setStatus(tab.loadError || 'Load failed');
    } else if (recording) {
      setStatus('Recording…');
    }
  } else {
    statsEl.textContent = 'IMPORT';
    setStatus('Target queue');
  }
}

async function invoke(channel, payload) {
  try {
    return await window.harBrowser.invoke(channel, payload);
  } catch (error) {
    setStatus(error.message);
    return null;
  }
}

async function navigate() {
  const tab = activeTab();
  if (!tab || tab.kind !== 'game') return;

  const url = addressEl.value.trim();
  if (!url) return;

  setStatus('Loading…');
  await invoke('tab:navigate', { url });
}

tabsEl.addEventListener('click', async (event) => {
  const tabButton = event.target.closest('.tab');
  if (!tabButton) return;

  const id = Number(tabButton.dataset.id);

  if (event.target.classList.contains('tab-close')) {
    await invoke('tab:close', { id });
    return;
  }

  await invoke('tab:activate', { id });
});

el('newTab').addEventListener('click', () => invoke('tab:new', {}));
backEl.addEventListener('click', () => invoke('tab:back'));
forwardEl.addEventListener('click', () => invoke('tab:forward'));
reloadEl.addEventListener('click', () => invoke('tab:reload', { ignoreCache: false }));
goEl.addEventListener('click', navigate);

addressEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') navigate();
});

speedEl.addEventListener('change', async () => {
  const result = await invoke('tab:set-speed', {
    speed: Number(speedEl.value)
  });

  if (result?.speed) {
    setStatus(
      `${result.speed}× · ${result.frames || 0} frames / ${result.targets || 0} targets`
    );
  }
});

recordEl.addEventListener('click', async () => {
  const result = await invoke('har:start', { reload: false });

  if (result?.ok) setStatus('Recording…');
  else if (result?.error) setStatus(result.error);
});

stopSaveEl.addEventListener('click', async () => {
  const result = await invoke('har:stop-save');

  if (result?.ok) setStatus(`Saved: ${result.path}`);
  else if (result?.canceled) setStatus('Capture continues');
  else if (result?.error) setStatus(result.error);
});

// The main process owns Ctrl+T / Ctrl+Tab / Ctrl+W so they work even when
// keyboard focus is inside a game WebContentsView.
document.addEventListener('keydown', async (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === 'l') {
    event.preventDefault();

    const tab = activeTab();
    if (tab?.kind !== 'game') return;

    addressEl.focus();
    addressEl.select();
  }

  if (
    event.ctrlKey &&
    event.shiftKey &&
    event.key.toLowerCase() === 's'
  ) {
    event.preventDefault();
    const result = await invoke('har:stop-save');
    if (result?.ok) setStatus(`Saved: ${result.path}`);
  }
});

window.harBrowser.onState((nextState) => {
  state = nextState;
  render();
});

invoke('browser:get-state').then((initialState) => {
  if (!initialState) return;
  state = initialState;
  render();
});
