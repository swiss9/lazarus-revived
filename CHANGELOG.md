# Changelog

All notable changes to Lazarus Form Recovery are documented here.

## [6.0.0] - 2026-10-20

### Added

- The Ankh UI: a field-anchored recovery button with per-field draft history.
- A redesigned popup with page/all draft scopes, filtering, selection, pinning, and history views.
- A redesigned options page with Overview, Silenced, Security, About, and Donation sections.
- Optional local vault encryption using AES-256-GCM, PBKDF2, and a session-only data key.
- PIN setup, unseal, change, and removal flows, plus configurable auto-lock.
- Draft export and import, retention controls, and per-site silencing.
- A top-level popup error logger that shows the exact error, file, and line number in the UI.
- Cross-browser background declaration using both `background.scripts` and `background.service_worker`.
- Chromium build tooling and web-ext project configuration.

### Changed

- Replaced the previous interface with the monochrome Ankh visual system across popup, options, and in-page controls.
- The background is now the single writer for vault data, with serialized writes and on-demand content-script injection.
- Settings are now written directly with `browser.storage.local.set` and synchronized with the background.
- Popup messaging now uses per-request timeouts and retries for read-only and no-receiver failures.
- The Ankh icon now survives focus retention, page re-renders, and DOM replacement after autofill.

### Fixed

- Settings not saving from the options page.
- The popup showing “LAZARUS IS NOT RESPONDING” when the background was slow to wake or unreachable.
- The dead Ankh icon after the first autofill, including lifecycle handling for newly rendered fields.
- Missing or mismatched popup DOM IDs causing null-reference failures.
- Async message listeners that did not reliably keep the response channel open.
- Startup failures when storage APIs or sender metadata were unavailable.

### Security

- Vault drafts are encrypted locally when a PIN is set; the PIN is never stored.
- Password fields and likely card, one-time-code, and recovery-phrase fields are ignored by default.
- No data is sent to external servers.
