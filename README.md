# Overleaf Assist Demo

This demo includes:
- A Tampermonkey userscript: `overleaf-assist-demo.user.js`
- A local bridge service that invokes your installed Codex CLI:
  - Desktop app host: `desktop/main.js` (Electron, tray + auto-start)
  - Manual fallback server: `proxy/server.js` (Node + Express)

## Quick start (desktop app, recommended)
1. Install Tampermonkey in your browser.
2. Create a new userscript and paste `overleaf-assist-demo.user.js`.
3. Install and run the desktop host:
   1. `npm install`
   2. `npm run start:desktop`
4. Ensure Codex CLI is installed and logged in:
   1. `codex --version`
   2. `codex login`
   3. On Windows PowerShell with script-policy restrictions, use `codex.cmd` instead of `codex`.
5. Open Overleaf. The assistant panel now opens by default.
6. Press `Ctrl+Alt+Shift+A` to toggle the panel open/closed.

Requires Node.js 18+.

## Persistent run (method 1: packaged desktop app)
Use this when you want the bridge to keep running across logins/reboots.

1. Build a packaged app:
   1. Windows: `npm run dist:win`
   2. macOS: `npm run dist:mac`
   3. Linux: `npm run dist:linux`
2. Install the built app from the generated artifact in `dist/`.
3. Launch it once after install.
4. The app will auto-start on login when packaged (Windows/macOS login item; Linux autostart entry).

## Manual fallback (legacy local server)
1. `cd proxy`
2. `npm install`
3. `npm start`

## Notes
- Default proxy URL: `http://localhost:8787/assist`
- The bridge runs `codex exec` per request and returns the last assistant message.
- Live feedback endpoint: `POST /assist-stream` (NDJSON events for run start/progress/summary/result/error).
- Model metadata endpoint: `GET /models` (used by UI for model + reasoning options).
- Health endpoint: `GET /health`
  - Includes `token_metrics` from latest streamed Codex run (usage + quota snapshot when available).
- Diagnostics endpoint: `GET /doctor`
- The assistant uses selection when available; otherwise it uses the full document.
- Apply modes: Smart Replace (default), Replace, Insert, Copy.
- Browser code cannot execute local CLI binaries directly, so a local bridge is required.
- The UI is a persistent terminal-style workspace (not a modal popup) with:
  - Dock-right (default), Floating, and Bottom-console layouts.
  - Chat transcript + message composer.
  - Content snapshot pane showing what will be sent.
  - Estimated token usage and model limit bar.
  - Auto-hide when no active Overleaf editor is available.
- Reasoning effort options are model-dependent when metadata is available.
- If model metadata cannot be loaded, the UI falls back to custom model entry + fixed reasoning options.
- Live progress in the userscript is a safe summary by default (stage updates + usage summary, not raw internal traces).
- Timeout is configurable in UI settings (`Timeout (s)`); leave empty to use bridge default `CODEX_TIMEOUT_MS`.

## Smart Replace (Default)
- Smart Replace supports both chat and edits:
  - Chat/explanations can be plain text.
  - When edits are requested, Codex should return structured edit blocks, and only matched ranges are applied.
- Required response contract:
  - Start: `<<<OVERLEAF_EDIT_BLOCKS>>>`
  - Per block:
    - `<<<SEARCH>>>`
    - exact source snippet
    - `<<<REPLACE>>>`
    - replacement snippet (can be empty for deletion)
  - End: `<<<END_OVERLEAF_EDIT_BLOCKS>>>`
- The UI builds a replace plan:
  - `resolved`: one exact match
  - `ambiguous`: multiple matches (you must pick a candidate)
  - `missing`: no match
- Smart Replace blocks changes when enabled items are unresolved or overlapping.
- `Use Legacy Replace` switches to classic full selection/document replace explicitly.

## Desktop app behavior
- Starts a local bridge on `localhost:8787`.
- Exposes tray actions:
  - Open Status
  - Restart Bridge
  - Run Codex Login
  - Quit
- Auto-start configuration:
  - Windows/macOS: login item enabled when packaged.
  - Linux: autostart desktop entry is created when packaged.
- Diagnostics window provides:
  - Codex install/login/network checks
  - Latest token usage and quota snapshot (from Codex `token_count` events when available)
  - Actionable issue codes (`codex_missing`, `codex_not_logged_in`, `network_blocked`, `port_in_use`)
- Tray tooltip shows readiness plus compact token usage/quota when available.

## Environment variables
- `BRIDGE_PORT` (optional): defaults to `8787` for `npm run start:bridge`
- `CODEX_BIN` (optional): Codex CLI executable (`codex` or `codex.cmd`)
- `CODEX_MODEL` (optional): default model passed to `codex exec --model`
- `CODEX_SANDBOX` (optional): defaults to `read-only`
- `CODEX_TIMEOUT_MS` (optional): defaults to `180000`
- `CODEX_HOME` (optional): set to a writable directory if Codex reports `failed to install system skills` / `Access is denied`

## Model and Reasoning Controls
- The userscript loads model metadata from `GET /models` derived from your proxy URL.
- Model selection supports:
  - Preset model dropdown (from local Codex metadata).
  - Custom model text input fallback.
- Reasoning effort supports:
  - `Use Codex Default`
  - Model-supported values (`minimal`, `low`, `medium`, `high`, `xhigh`, depending on model).
- `/assist` accepts optional `reasoning_effort`:
  - `default`, `minimal`, `low`, `medium`, `high`, `xhigh`
- `/assist` and `/assist-stream` accept optional `timeout_ms`:
  - positive integer in milliseconds
  - overrides bridge default timeout for that run only
- `/assist-stream` request body matches `/assist` and responds with NDJSON events:
  - `run_started`: `{ event, request_id, model, reasoning_effort, timestamp }`
  - `progress`: `{ event, request_id, stage, message, timestamp }`
  - `summary`: `{ event, request_id, elapsed_ms, usage, warnings_count }`
  - `result`: `{ event, request_id, output_text, elapsed_ms, usage, response_id }`
  - `error`: `{ event, request_id, message, status }`

## Packaging
- Build all desktop targets:
  - `npm run dist:desktop`
- Build one target:
  - `npm run dist:win`
  - `npm run dist:mac`
  - `npm run dist:linux`
- Windows note:
  - This project sets `build.win.signAndEditExecutable=false` to avoid Windows symlink-privilege failures when extracting `winCodeSign`.
  - If you need executable metadata editing/signing behavior, enable Windows Developer Mode (or run elevated) and remove that flag.
