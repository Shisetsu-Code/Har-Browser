'use strict';

const el = (id) => document.getElementById(id);

const chooseEl = el('choose');
const startEl = el('start');
const pauseEl = el('pause');
const loadOneEl = el('loadOne');
const clearEl = el('clear');
const lookAheadEl = el('lookAhead');

const harStartEl = el('harStart');
const harPauseEl = el('harPause');
const harRetryEl = el('harRetry');
const harResetEl = el('harReset');
const harFolderEl = el('harFolder');

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
  errors: 0,
  harArchive: {
    total: 0,
    completed: 0,
    failed: 0,
    remaining: 0,
    running: false,
    currentUrl: '',
    currentIndex: -1,
    outputDir: '',
    lastFile: ''
  }
};

function render(next) {
  state = {
    ...state,
    ...next,
    harArchive: {
      ...state.harArchive,
      ...(next?.harArchive || {})
    }
  };

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

  const har = state.harArchive;

  el('harTotal').textContent =
    String(har.total || 0);

  el('harCompleted').textContent =
    String(har.completed || 0);

  el('harRemaining').textContent =
    String(har.remaining || 0);

  el('harFailed').textContent =
    String(har.failed || 0);

  el('harOutput').textContent =
    har.outputDir || '';

  if (har.currentUrl) {
    const position =
      Number.isInteger(har.currentIndex) &&
      har.currentIndex >= 0
        ? `${har.currentIndex + 1}/${har.total}`
        : '';

    el('harState').textContent =
      har.running
        ? 'Capturing HAR…'
        : 'Finishing current HAR…';

    el('harCurrent').textContent =
      `${position} ${har.currentUrl}`.trim();
  } else {
    el('harCurrent').textContent = '';

    if (har.running) {
      el('harState').textContent =
        'HAR archive running…';
    } else if (har.total > 0 && har.remaining === 0 && har.failed === 0) {
      el('harState').textContent =
        'HAR archive complete.';
    } else if (har.total > 0) {
      el('harState').textContent =
        'HAR archive paused / ready.';
    } else {
      el('harState').textContent =
        'Archive idle.';
    }
  }

  harStartEl.disabled =
    har.running ||
    !har.total ||
    !har.remaining;

  harPauseEl.disabled =
    !har.running;

  harRetryEl.disabled =
    har.running ||
    !har.failed;

  harResetEl.disabled =
    har.running ||
    Boolean(har.currentUrl) ||
    (!har.completed && !har.failed);

  harFolderEl.disabled =
    !har.outputDir;
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

harStartEl.addEventListener(
  'click',
  () => invoke('hararchive:start')
);

harPauseEl.addEventListener(
  'click',
  () => invoke('hararchive:pause')
);

harRetryEl.addEventListener(
  'click',
  () => invoke('hararchive:retry-failed')
);

harResetEl.addEventListener(
  'click',
  () => invoke('hararchive:reset')
);

harFolderEl.addEventListener(
  'click',
  () => invoke('hararchive:open-folder')
);

window.targetImport.onState(render);
invoke('import:get-state');
