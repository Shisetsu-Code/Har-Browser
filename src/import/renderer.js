'use strict';

const el = (id) => document.getElementById(id);

const chooseEl = el('choose');
const startEl = el('start');
const pauseEl = el('pause');
const loadOneEl = el('loadOne');
const clearEl = el('clear');
const lookAheadEl = el('lookAhead');

let state = {
  total: 0,
  opened: 0,
  remaining: 0,
  running: false,
  loading: false,
  lookAhead: 6,
  aheadLoaded: 0,
  activePosition: 0,
  filePath: '',
  errors: 0
};

function render(next) {
  state = { ...state, ...next };

  el('total').textContent =
    String(state.total || 0);

  el('opened').textContent =
    String(state.opened || 0);

  el('remaining').textContent =
    String(state.remaining || 0);

  el('ahead').textContent =
    String(state.aheadLoaded || 0);

  el('file').textContent =
    state.filePath || '';

  el('position').textContent =
    state.activePosition > 0
      ? `Position ${state.activePosition}/${state.total}`
      : '';

  lookAheadEl.value =
    String(state.lookAhead || 6);

  startEl.disabled =
    state.running ||
    !state.remaining;

  pauseEl.disabled =
    !state.running;

  loadOneEl.disabled =
    state.running ||
    !state.remaining;

  clearEl.disabled =
    state.loading ||
    !state.total;

  if (state.loading) {
    el('stateText').textContent =
      'Prefetching ahead…';
  } else if (state.running) {
    el('stateText').textContent =
      'Following your tab position.';
  } else if (state.remaining > 0) {
    el('stateText').textContent =
      'Ready.';
  } else if (state.total > 0) {
    el('stateText').textContent =
      'All targets have been opened.';
  } else {
    el('stateText').textContent =
      'No targets loaded.';
  }

  if (state.errors > 0) {
    el('stateText').textContent +=
      ` · ${state.errors} errors`;
  }
}

async function invoke(channel, payload) {
  try {
    const result =
      await window.targetImport.invoke(
        channel,
        payload
      );

    if (result) render(result);
    return result;
  } catch (error) {
    el('stateText').textContent =
      error.message;

    return null;
  }
}

chooseEl.addEventListener(
  'click',
  () => invoke('import:choose-targets')
);

startEl.addEventListener(
  'click',
  () => invoke('import:start')
);

pauseEl.addEventListener(
  'click',
  () => invoke('import:pause')
);

loadOneEl.addEventListener(
  'click',
  () => invoke('import:load-one')
);

clearEl.addEventListener(
  'click',
  () => invoke('import:clear')
);

lookAheadEl.addEventListener(
  'change',
  () => {
    invoke(
      'import:set-look-ahead',
      {
        lookAhead:
          Number(lookAheadEl.value)
      }
    );
  }
);

window.targetImport.onState(render);

invoke('import:get-state');
