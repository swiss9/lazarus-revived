# Lazarus: Form Recovery

A modern Manifest V3 revival of the classic **Lazarus Form Recovery** extension for Firefox and
Microsoft Edge, on desktop and Android. Lazarus records what you type into forms and keeps a local
history of every draft, so a crash, a stray navigation, or a closed tab never costs you your words.

| Browser | Desktop | Mobile |
| --- | --- | --- |
| Firefox | Yes (140+) | Yes (Firefox for Android 142+) |
| Microsoft Edge | Yes (Chromium 120+) | Yes (Edge for Android 134+, from Edge Add-ons) |

Firefox for iOS and Edge for iOS do not support browser extensions.

- **Add-on listing:** https://addons.mozilla.org/en-US/firefox/addon/lazarus-form-recovery/
- **Source code:** https://github.com/swiss9/lazarus-revived

Everything stays on your device. There is no account, no sync service, no analytics, and no
network request.

## Features

- **Automatic capture** — text, search, email, URL, tel, number and textarea fields are saved as
  you type. Password, card, one-time-code and recovery-phrase fields are ignored unless you
  explicitly enable password saving.
- **Per-field history** — the last 10 versions of each field are kept, so you can go back further
  than the most recent draft.
- **Resurrect a page** — restore every saved field at once from the popup or the right-click menu.
- **In-field ankh** — click the small ankh beside a field to see and restore its saved versions.
- **Command palette** — `Ctrl+Shift+L` (`⌃⇧L` on macOS) opens a searchable list of drafts for the
  current page. On Android, where there is no keyboard shortcut, use **Palette** in the popup footer.
- **Filter and browse** — search the whole vault from the popup, with page/all scopes.
- **Silenced sites** — stop recording a site from its popup or right-click menu.
- **Optional PIN vault** — encrypt the vault with AES-256-GCM, a PBKDF2-SHA-256 key (600,000
  iterations) and an inactivity auto-lock. Changing the PIN rewraps only the data key, never the
  stored drafts.
- **Import / export** — plain JSON backup of every draft.
- **Local only** — all data lives in `browser.storage.local`; nothing is transmitted.

## Install for development

1. Clone this repository.
2. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on…** and select `manifest.json`.

Or use `web-ext`:

```sh
npm install
npm start
```

The temporary add-on is removed when Firefox closes. Signed builds from AMO persist normally.

### Firefox for Android

The same build supports Firefox for Android 142 and later. Install it from the add-on's AMO page
(**Add to Firefox**), or load it temporarily over USB with `web-ext run -t firefox-android`.
The popup is a bottom sheet: it adapts to the phone width and height, and the in-field ankh and
its history panel use finger-sized targets. Context-menu actions are desktop-only because Firefox
for Android does not expose the `contextMenus` API.

### Microsoft Edge (Chromium)

Edge uses the same source with a Chromium manifest. Build the unpacked folder and ZIP with:

```sh
npm run build:chromium
```

Then open `edge://extensions`, enable **Developer mode**, choose **Load unpacked** and select
`dist/chromium`. The store-ready archive is `dist/lazarus-chromium-6.0.0.zip`.

Edge for Android 134 and later can run extensions, but only ones installed from **Edge Add-ons**
(the mobile build does not load an unpacked folder or a local ZIP). Publish the Chromium ZIP in the
Edge Add-ons Partner Center and request mobile availability for the listing. On Android Edge,
`contextMenus` and `commands` are not exposed; the extension already guards both, and **Palette**
in the popup footer replaces the keyboard shortcut. Settings fall back to opening `options.html`
in a tab when the mobile build has no options UI.

## Build for addons.mozilla.org (AMO)

```sh
npm install
npm run release
```

`npm run release` writes two upload-ready archives to `dist/`:

- `lazarus_form_recovery-6.0.0.zip` — Firefox/AMO, event page via `background.scripts`.
- `lazarus-chromium-6.0.0.zip` — Chrome/Edge, service worker via `background.service_worker`.

Both archives contain `manifest.json` at their root and only the runtime files (no `.git`, docs,
`node_modules`, or build tooling). `npm run lint` checks the Firefox package only.

`npm audit --omit=dev` is clean. The few advisories reported by a plain `npm audit` come from
`web-ext`'s optional Android tooling and are development-only; none of it is shipped in the ZIP.

To check the package without uploading:

```sh
npm run lint
unzip -l dist/*.zip
```

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `storage` | Store drafts, settings and the silenced-site list locally. |
| `activeTab` | Let the popup and context menu act on the tab the user is currently viewing. |
| `scripting` | Re-inject the content script into tabs that were already open when the extension was installed or updated, so restore works without reloading the page. |
| `contextMenus` | Add “Resurrect this page” and “Silence / unsilence this site”. |
| `idle` | Auto-lock an encrypted vault after the configured inactivity period. |
| `<all_urls>` | The content script must detect and restore forms on any website. No page data is sent anywhere. |
| `unlimitedStorage` | Chromium/Edge build only: Chrome caps `storage.local` at 10 MB, which a full vault can exceed. Firefox does not need it. |

## Privacy

See [PRIVACY.md](PRIVACY.md). Short version: everything is stored locally, nothing is collected,
and the extension makes no network requests.

## Data and security notes

- The vault is **unencrypted by default**. Set a PIN in **Settings → Security** to encrypt drafts.
- The PIN cannot be recovered. Removing the PIN stores the vault as plain text again.
- Export files are unencrypted JSON. Store them somewhere safe.
- Drafts are capped at 500 entries, 10 versions per field and 10,000 characters per version.
- If the browser clears extension storage (for example, “Clear browsing data” with site data
  selected), drafts are deleted with it.

## Credits

Thanks to the original **Lazarus Form Recovery** add-on and its authors. It rescued a lot of lost
text before it was abandoned, and this project exists because of it.

## License

GNU General Public License v3.0. See [LICENSE.txt](LICENSE.txt).
