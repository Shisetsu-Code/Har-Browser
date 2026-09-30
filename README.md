# HAR Browser

A small Chromium-based browser focused on capturing game traffic quickly without background tabs being throttled.

## What it does

- Uses Electron/Chromium with persistent cookies and cache.
- Disables Chromium background timer/renderer throttling.
- Keeps the Page Visibility API in an active state for tabs where **ACTIVE** is enabled.
- Keeps the application from being suspended while HAR Browser is open.
- Captures network traffic through Chromium DevTools Protocol (CDP), not a proxy.
- Exports standard HAR 1.2 files.
- Captures request methods, URLs, headers, query strings, POST bodies, response headers and useful response bodies.
- Adds WebSocket frames in the non-standard HAR field `_webSocketFrames` so game protocol traffic is not lost.
- Uses GPU acceleration normally and explicitly enables GPU rasterization/zero-copy paths.
- Starts every game tab muted by default; sound can be enabled per tab.
- Provides per-tab runtime speed controls at 1×, 2×, 4× and 8×.
- Enables GAME ONLY by default so exported HARs retain XHR/fetch/WebSocket/non-GET protocol traffic while dropping asset noise and OPTIONS preflight requests.

## Run on Windows

Requirements: Node.js 24+ and npm.

```powershell
git clone https://github.com/Shisetsu-Code/Har-Browser.git
cd Har-Browser
npm install
npm start
```

## Fast capture workflow

1. Open the game URL.
2. Leave **ACTIVE** enabled.
3. Press **REC + RELOAD** to capture the complete load, or **REC** to capture only new traffic.
4. Play/spin/change bets as needed.
5. Press **STOP + SAVE HAR** and choose the destination.

The save dialog is shown before capture is stopped. If you cancel the dialog, recording continues.

## Shortcuts

- `Ctrl+L`: focus address bar.
- `Ctrl+T`: new tab.
- `Ctrl+W`: close current tab.
- `Ctrl+Shift+H`: REC + reload without cache.
- `Ctrl+Shift+S`: stop and save HAR.

## ACTIVE mode

Electron's `backgroundThrottling=false` prevents animation/timer throttling and affects Chromium's Page Visibility API. HAR Browser also applies a small document-start patch that reports `document.hidden=false`, `document.visibilityState="visible"` and `document.hasFocus()=true` while ACTIVE mode is enabled, and suppresses visibility/focus pause events.

This is intentionally aggressive because the browser is intended for QA/protocol inspection of games. If a site behaves incorrectly with that patch, switch the tab from **ACTIVE** to **NORMAL**.

## HAR body policy

To keep capture responsive on asset-heavy games:

- Metadata for network requests is retained.
- Response bodies are fetched for Document/XHR/Fetch/Other requests.
- Individual bodies larger than 8 MiB are skipped.
- WebSocket payloads are retained as frames.

This avoids filling HAR files with large images/audio/video while preserving API/game protocol traffic.

## Security

HAR files can contain session tokens, authorization headers, cookies, POST bodies and gameplay/account data. Treat captures as private credentials and do not commit them. The repository ignores `*.har` by default.

## Development

```powershell
npm test
npm run check
```

Architecture:

- `src/main.js`: browser tabs, WebContentsView lifecycle, anti-throttling switches and IPC.
- `src/har-recorder.js`: CDP-to-HAR capture engine.
- `src/tab-preload.js`: ACTIVE-mode visibility/focus patch.
- `src/ui/*`: browser chrome.


## Runtime controls

Each tab keeps its own settings:

- **ACTIVE**: prevents background timer/visibility throttling.
- **1× / 2× / 4× / 8×**: accelerates JavaScript timers, animation clocks and requestAnimationFrame time seen by the page. This speeds local game animations and client-side waits; it does not reduce server/network latency.
- **MUTED**: enabled by default. It mutes audio output without blocking the game from loading audio resources.
- **GAME ONLY**: enabled by default. The browser still observes the full network stream, but the saved HAR removes asset traffic and CORS OPTIONS noise and keeps API/protocol traffic such as XHR, fetch, WebSocket and POST requests.

Switch **GAME ONLY** to **FULL HAR** before saving when you need every resource request.


## Resident background tabs

HAR Browser keeps every opened game tab attached to the same BrowserWindow instead of removing inactive WebContentsViews. Switching tabs only raises the selected view to the top. This is intentional: background games remain resident, visible to Chromium, unthrottled, and continue running while another tab is selected. This uses more CPU/GPU than a normal browser because all game tabs are allowed to render continuously.


## 0.4 compact workflow

The native Electron menu is removed on Windows and the browser chrome is reduced to 68 px. HAR capture controls live in the tab row: **REC** and **STOP+SAVE HAR**.

The per-tab ACTIVE, MUTED and GAME ONLY buttons are intentionally hidden from the compact UI. Game tabs still start with ACTIVE=true, MUTED=true and GAME ONLY=true.

Keyboard workflow:

- `Ctrl+T`: open a new game tab from anywhere, including while focus is inside a game.
- `Ctrl+Tab`: move to the next game tab.
- `Ctrl+Shift+Tab`: move to the previous game tab.
- `Ctrl+W`: close the active game tab.
- `Ctrl+L`: focus the URL field when the browser chrome has focus.
- `Ctrl+Shift+S`: stop and save the active HAR capture.

An always-present **IMPORT** tab loads a `targets.txt` file. The queue can open 5 or 6 games per batch (6 by default). Tabs in a batch are staggered, the queue waits for their first page load or timeout, pauses briefly, then opens the next batch. Imported games open in the background and do not steal focus.


## 0.4.1 rolling prefetch and clean tab switching

Inactive WebContentsViews remain attached to the BrowserWindow but are hidden from display. Each view has an opaque dark background, so an empty/new tab cannot expose pixels from the previously selected game. Background throttling remains disabled.

The accelerated requestAnimationFrame shim no longer depends on Chromium producing a visible compositor frame. It is pumped by a native timer, allowing hidden resident game tabs to continue advancing their JavaScript animation/game loops.

targets.txt import now uses rolling prefetch instead of batches. START PREFETCH opens the next 5 or 6 targets one at a time, approximately 700 ms apart. When the user advances to an imported game tab, the prefetch frontier advances too and opens only enough additional targets to restore the configured 5/6-game look-ahead window. It never proceeds through the entire target list merely because time passes.


## 0.5.0 persistent HAR archive

The IMPORT tab now includes a persistent HAR archive queue.

- Loading a targets.txt list also synchronizes it with the HAR archive.
- HAR capture is intentionally serial: one target at a time with a short pause between targets.
- Archive progress is stored under Electron userData in har-archive-state.json.
- Completed HAR files are stored in the user's Downloads/HAR-Browser-HARs directory.
- Existing HAR files are detected by deterministic URL-based filenames and reused to rebuild progress.
- If the application is restarted while the archive was running, the queue resumes from the first unfinished target.
- Failed targets are kept separately and can be retried from the IMPORT tab.
- Each automatic HAR captures the initial page load plus a short settle period.

Inactive game tabs are no longer hidden with setVisible(false). They remain compositor-visible and are parked outside the BrowserWindow bounds, preserving their renderer/rAF activity without drawing over the active tab. When selected, the view is moved back into the viewport and invalidated to force immediate presentation.
