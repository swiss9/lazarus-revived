# Privacy Policy

**Lazarus Form Recovery v6.0.0**

Lazarus is designed to keep your form drafts on your own device. It does not operate any servers and does not transmit extension data to any external service.

## What Lazarus stores

Lazarus stores the following information locally in your browser profile using `browser.storage.local`:

- Text you enter into supported form fields, together with the page URL, field identifier, timestamps, and draft history.
- Extension settings, such as retention period, password-field handling, palette options, and auto-lock preferences.
- The list of sites you have silenced.
- Vault metadata, including the salt and wrapped encryption key when a PIN is configured.

When you set a PIN, draft data is encrypted locally with AES-256-GCM before it is written to storage. Your PIN is never stored. The derived encryption key is kept only for the current browser session using `browser.storage.session`.

## What Lazarus does not do

- It does not send drafts, settings, browsing activity, or any other extension data to external servers.
- It does not include analytics, telemetry, advertising, or tracking.
- It does not sell or share data with third parties.
- It does not use remote code.

## Your control over the data

You can view, restore, pin, delete, export, and import drafts from the Lazarus popup and options page. Export creates a local JSON file that you control. You can erase all drafts and the PIN at any time from the Security tab in settings. Uninstalling the extension removes its extension storage according to your browser's normal behavior.

## Permissions

Lazarus requests only the permissions needed to provide form recovery:

- `storage` to keep drafts and settings locally.
- `activeTab` and `scripting` to restore drafts into the current page.
- `contextMenus` to add restore and silence actions.
- `idle` to support auto-locking the vault.
- Host access to pages where you use the extension, so it can detect form fields and restore drafts.

## Contact

Questions or concerns can be raised through the project repository:

https://github.com/swiss9/lazarus-revived

_Last updated: 2026-10-20_
