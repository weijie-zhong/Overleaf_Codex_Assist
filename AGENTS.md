# Project Guardrails

This project directory is synced by OneDrive.

## Build/Compilation Rule

- Do not write temporary, cache, or intermediate compilation files inside this repository.
- Route all temp artifacts to a local non-OneDrive folder, for example:
  - `%LOCALAPPDATA%\Codex_Assist\build-temp`
  - `%TEMP%\Codex_Assist`
- Keep only:
  - source files
  - build/compilation scripts
  - documents
  - final binary artifacts (for this project: `.exe`)

## Expected Cleanup Behavior

- After each build, remove transient artifacts and keep the repo clean.
- Do not commit dependency or unpacked build directories generated during compilation.

## Working Build Strategy

- Do not run release builds directly from this OneDrive repo if they require dependency installation or Electron packaging.
- Create a minimal isolated build workspace under `%LOCALAPPDATA%\Codex_Assist\build-src\<release-name>`.
- Copy only the files needed for packaging into that temp workspace:
  - `desktop/`
  - `proxy/bridge.js`
  - `proxy/server.js`
  - `proxy/package.json`
  - `proxy/package-lock.json`
  - `package.json`
  - `package-lock.json`
  - `README.md`
  - `overleaf-assist-demo.user.js`
  - `AGENTS.md`
- Run `npm install` inside the temp workspace, not inside the repo.
- Send Electron build output to `%LOCALAPPDATA%\Codex_Assist\build-out\<release-name>` with `electron-builder --config.directories.output=...`.
- For this project, `--config.npmRebuild=false` was required for packaging stability in the temp workspace.
- If Electron runtime checks are needed, clear `ELECTRON_RUN_AS_NODE` first.
- Copy back only the final installer `.exe` into the repo `dist/` folder.
- Keep `dist/` limited to the current release installer and remove older installers.

## Cleanup Commands That Worked

- If PowerShell `Remove-Item` is blocked by policy, use `cmd` cleanup commands instead:
  - delete a directory: `cmd /c if exist <dir> rmdir /s /q <dir>`
  - delete a file: `cmd /c if exist <file> del /f /q <file>`
- After a build, remove:
  - repo `node_modules`
  - temp build workspace under `%LOCALAPPDATA%\Codex_Assist\build-src`
  - temp packaged output under `%LOCALAPPDATA%\Codex_Assist\build-out`
  - temp build/cache folders under `%LOCALAPPDATA%\Codex_Assist\build-temp`
  - optional local caches under `%LOCALAPPDATA%\Codex_Assist\electron-builder-cache`
  - optional local caches under `%LOCALAPPDATA%\Codex_Assist\npm-cache`
