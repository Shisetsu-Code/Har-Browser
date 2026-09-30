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
