'use strict';

const el = (id) => document.getElementById(id);

const tabsEl = el('tabs');
const addressEl = el('address');
const statusEl = el('status');
const statsEl = el('stats');
const recordEl = el('record');
const recordReloadEl = el('recordReload');
const stopSaveEl = el('stopSave');
const keepActiveEl = el('keepActive');
const speedEl = el('speed');
const muteEl = el('mute');
const gameOnlyEl = el('gameOnly');

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
      tab.stats?.recording ? 'recording' : ''
    ].filter(Boolean).join(' ');
    tabButton.dataset.id = String(tab.id);

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || tab.url || 'New Tab';

    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close tab';

    tabButton.append(title, close);
    tabsEl.append(tabButton);
  }

  const tab = activeTab();
  if (!tab) return;

  if (document.activeElement !== addressEl) {
    addressEl.value = tab.url === 'about:blank' ? '' : tab.url;
  }

  const recording = Boolean(tab.stats?.recording);
  recordEl.disabled = recording;
  recordReloadEl.disabled = recording;
  stopSaveEl.disabled = !recording;
  recordEl.classList.toggle('recording', recording);
  recordReloadEl.classList.toggle('recording', recording);

  keepActiveEl.classList.toggle('active-mode', tab.keepActive);
  keepActiveEl.textContent = tab.keepActive ? 'ACTIVE' : 'NORMAL';

  speedEl.value = String(tab.speed || 1);

  muteEl.classList.toggle('active-mode', tab.muted);
  muteEl.textContent = tab.muted ? 'MUTED' : 'SOUND';

  gameOnlyEl.classList.toggle('active-mode', tab.gameOnly);
  gameOnlyEl.textContent = tab.gameOnly ? 'GAME ONLY' : 'FULL HAR';

  statsEl.textContent =
    `${tab.stats?.requests || 0} requests · ${humanBytes(tab.stats?.bytes || 0)} · ${tab.stats?.wsFrames || 0} WS frames`;

  if (recording) setStatus('Recording network traffic…');
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
el('back').addEventListener('click', () => invoke('tab:back'));
el('forward').addEventListener('click', () => invoke('tab:forward'));
el('reload').addEventListener('click', () => invoke('tab:reload', { ignoreCache: false }));
el('go').addEventListener('click', navigate);
addressEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') navigate();
});

keepActiveEl.addEventListener('click', async () => {
  await invoke('tab:toggle-keep-active');
});

speedEl.addEventListener('change', async () => {
  const speed = await invoke('tab:set-speed', { speed: Number(speedEl.value) });
  if (speed) setStatus(`Runtime speed: ${speed}×`);
});

muteEl.addEventListener('click', async () => {
  const muted = await invoke('tab:toggle-mute');
  setStatus(muted ? 'Tab muted' : 'Tab sound enabled');
});

gameOnlyEl.addEventListener('click', async () => {
  const gameOnly = await invoke('tab:toggle-game-only');
  setStatus(gameOnly ? 'GAME ONLY HAR enabled' : 'Full HAR enabled');
});

recordEl.addEventListener('click', async () => {
  const result = await invoke('har:start', { reload: false });
  if (result?.ok) setStatus('Recording started');
  else if (result?.error) setStatus(result.error);
});

recordReloadEl.addEventListener('click', async () => {
  const result = await invoke('har:start', { reload: true });
  if (result?.ok) setStatus('Recording started; page reloading without cache');
  else if (result?.error) setStatus(result.error);
});

stopSaveEl.addEventListener('click', async () => {
  const result = await invoke('har:stop-save');
  if (result?.ok) setStatus(`Saved: ${result.path}`);
  else if (result?.canceled) setStatus('Save canceled; capture continues');
  else if (result?.error) setStatus(result.error);
});

document.addEventListener('keydown', async (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === 'l') {
    event.preventDefault();
    addressEl.focus();
    addressEl.select();
  }

  if (event.ctrlKey && event.key.toLowerCase() === 't') {
    event.preventDefault();
    await invoke('tab:new', {});
  }

  if (event.ctrlKey && event.key.toLowerCase() === 'w') {
    event.preventDefault();
    if (state.activeTabId) await invoke('tab:close', { id: state.activeTabId });
  }

  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'h') {
    event.preventDefault();
    const result = await invoke('har:start', { reload: true });
    if (result?.ok) setStatus('Recording started; page reloading without cache');
  }

  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 's') {
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
