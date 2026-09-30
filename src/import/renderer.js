'use strict';

const el = (id) => document.getElementById(id);

const chooseEl = el('choose');
const startEl = el('start');
const pauseEl = el('pause');
const nextEl = el('next');
const clearEl = el('clear');
const batchSizeEl = el('batchSize');

let state = {
  total: 0,
  opened: 0,
  remaining: 0,
  currentBatch: 0,
  running: false,
  loading: false,
  batchSize: 6,
  filePath: ''
};

function render(next) {
  state = { ...state, ...next };

  el('total').textContent = String(state.total || 0);
  el('opened').textContent = String(state.opened || 0);
  el('remaining').textContent = String(state.remaining || 0);
  el('batch').textContent = String(state.currentBatch || 0);
  el('file').textContent = state.filePath || '';

  batchSizeEl.value = String(state.batchSize || 6);

  startEl.disabled = state.running || state.loading || !state.remaining;
  pauseEl.disabled = !state.running;
  nextEl.disabled = state.running || state.loading || !state.remaining;
  clearEl.disabled = state.running || state.loading || !state.total;

  if (state.loading) {
    el('stateText').textContent = 'Loading current batch…';
  } else if (state.running) {
    el('stateText').textContent = 'Queue running…';
  } else if (state.remaining > 0) {
    el('stateText').textContent = 'Queue ready.';
  } else if (state.total > 0) {
    el('stateText').textContent = 'Queue complete.';
  } else {
    el('stateText').textContent = 'No targets loaded.';
  }
}

async function invoke(channel, payload) {
  try {
    const result = await window.targetImport.invoke(channel, payload);
    if (result) render(result);
    return result;
  } catch (error) {
    el('stateText').textContent = error.message;
    return null;
  }
}

chooseEl.addEventListener('click', () => invoke('import:choose-targets'));
startEl.addEventListener('click', () => invoke('import:start'));
pauseEl.addEventListener('click', () => invoke('import:pause'));
nextEl.addEventListener('click', () => invoke('import:next-batch'));
clearEl.addEventListener('click', () => invoke('import:clear'));

batchSizeEl.addEventListener('change', () => {
  invoke('import:set-batch-size', { batchSize: Number(batchSizeEl.value) });
});

window.targetImport.onState(render);
invoke('import:get-state');
