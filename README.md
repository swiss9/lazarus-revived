# Lazarus Form Recovery v6.0

Lazarus saves what you type into web forms and lets you bring it back after a crash, an accidental navigation, a closed tab, or a broken submit button. Drafts and settings stay on your device.

Version 6.0 introduces the **Ankh UI**: a compact, field-anchored ankh button that appears beside inputs, opens the draft history for that field, and restores a previous version with one click. The popup and options pages were rebuilt around the same visual language, with a vault that can be encrypted locally using a PIN.

## Features

- Automatic draft capture for text inputs, text areas, and contenteditable fields.
- Version history for every field, with pinning, restoring, and deletion.
- Optional local vault encryption using AES-256-GCM and PBKDF2.
- The Ankh icon for quick per-field recovery.
- Command palette (`Ctrl+Shift+L`) for searching drafts on the current page.
- Per-site silencing, retention controls, export/import, and auto-lock.
- No accounts, analytics, telemetry, or external servers.

## Requirements

- Node.js 18 or newer for development tooling.
- Firefox 140+ for the Firefox build.
- Chrome/Chromium 121+ for the Chromium build.

## Install dependencies

```bash
npm install
```

## Load in Firefox

For a temporary development install:

```bash
npm start
```

Or load the project manually:

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select `manifest.json` in the project root.

To produce a distributable Firefox archive:

```bash
npm run build
```

The signed-ready archive is written to `web-ext-artifacts/`.

## Load in Chrome / Chromium

Build the Chromium-specific package first. The build script copies the runtime files to `dist/chromium` and rewrites the manifest to use a Manifest V3 service worker.

```bash
npm run build:chromium
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the `dist/chromium` directory.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm start` | Run the extension in Firefox with web-ext |
| `npm run start:android` | Run on Firefox for Android |
| `npm run lint` | Lint the extension with web-ext |
| `npm run build` | Build the Firefox archive with web-ext |
| `npm run build:chromium` | Build the unpacked Chromium package |
| `npm run build:all` | Build both Firefox and Chromium packages |
| `npm run clean` | Remove build output and artifacts |

## Privacy

Lazarus stores data locally with `browser.storage.local` and does not send extension data to external servers. See [PRIVACY.md](PRIVACY.md) for details.

## License

GNU General Public License v3.0. See [LICENSE.txt](LICENSE.txt).
