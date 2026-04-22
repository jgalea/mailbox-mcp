# Changelog

## 0.6.2 — 2026-04-22

### Fixed
- Gmail `batch_modify_emails` and `trash_emails` no longer stall the MCP connection on large batches. Both paths now issue a single `users.messages.batchModify` API call per 1000 message ids instead of looping one request per message. Previously, calls in the hundreds would trigger `MCP error -32000: Connection closed` before the Gmail side had finished processing.

## 0.6.1 — 2026-04-20

### Security
- `multi_account_search` now redacts tokens and strips absolute paths from per-account error messages before returning them to the MCP client.
- Defense-in-depth: `stripCRLF` applied to the SMTP envelope addresses in the IMAP `sendDraft` path.

## 0.6.0 — 2026-04-20

### Added

- **`mark_read`** — mark a message as read or unread. Wraps the provider-specific flag/label dance.
- **`star_email`** — star or unstar a message (Gmail `STARRED` label, IMAP `\Flagged`, JMAP `$flagged` keyword).
- **`archive_email`** — archive a message. Gmail removes the INBOX label, IMAP moves to the Archive folder, JMAP moves out of the inbox mailbox.
- **`list_drafts`** / **`send_draft`** — drafts are now first-class. List existing drafts and send them as-is.
- **`count_unread_by_label`** — show unread counts per label/folder, sorted by volume.
- **`export_email`** / **`export_thread`** — save messages as raw RFC 822 `.eml` files to a safe directory. Useful for archival or migration.
- **`emails_since`** — list messages received after a given ISO 8601 timestamp. Optional `folder` scope. Enables polling-based assistants.
- **`multi_account_search`** — run the same query across every configured account in parallel, merged by alias.
- `search_emails` now accepts an optional **`folder`** parameter. IMAP searches the given mailbox (was INBOX-only); Gmail adds a `label:` prefix; JMAP filters by `inMailbox`.

### Changed

- `MailProvider.searchMessages` gained an optional third parameter (`folder?`). Backwards compatible.
- New optional `MailProvider` methods: `markRead`, `starMessage`, `archiveMessage`, `listDrafts`, `sendDraft`, `countUnreadByLabel`, `exportMessage`, `messagesSince`.
- Save-path validation (`/tmp`, `~/Downloads/mailbox-mcp`) extracted from `attachments.ts` into a shared `security/save-path.ts` module and reused by the export tools.

## 0.5.1 — 2026-04-20

### Changed
- Release tarballs now ship with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) attestations. Published via GitHub Actions OIDC (trusted publisher).

## 0.5.0 — 2026-04-20

### Breaking
- Removed `search_contacts` tool (was a stub returning instructions, never implemented).
- Removed `snooze_email`, `list_snoozed`, `check_snoozed` tools (applied a non-existent SNOOZED label and ignored the `until` parameter).
- Dropped the `contacts.readonly` OAuth scope; re-authenticating Gmail accounts now requests fewer permissions.
- `ProviderCapabilities` no longer exposes `snooze` or `contacts` fields.
- IMAP message IDs are now `folder:uid` (e.g. `INBOX:42`). Bare UIDs are still accepted for backwards compatibility and assumed to live in INBOX.

### Fixed
- **JMAP**: HTML-only messages no longer return an empty body. Text body is preferred; falls back to HTML when no `text/plain` part exists.
- **IMAP**: wildcard/empty search now fetches the most recent UIDs instead of sending `*` as a literal subject search.
- **IMAP**: `trashMessages` locks the correct source folder for each UID instead of always locking INBOX.
- **IMAP**: `modifyLabels` now validates flag names against the RFC 3501 list and rejects folder-style labels with a clear error, instead of silently sending folder names as flags.
- **IMAP**: `downloadAttachment` returns the real filename and MIME type from `bodyStructure`, and decodes base64/quoted-printable/charsets correctly via `imapflow.download()`.
- **IMAP**: connections auto-reconnect on socket close. The provider cache is evicted when the underlying connection drops, so the next tool call opens a fresh session.
- **IMAP**: message body extraction now uses `imapflow.download()` instead of a hand-rolled MIME regex, decoding quoted-printable, base64, and non-UTF-8 charsets.
- Server version now reads from `package.json` (was hardcoded as `0.1.0`).
- `read_thread` enforces the `threads` capability — IMAP returns "not supported" instead of a misleading single-message pseudo-thread.
- Reply-all address parsing preserves commas inside quoted display names (e.g. `"Smith, John" <j@x>`).
- `Re:` / `Fwd:` prefixes are normalised consistently across providers (case-insensitive, no false positives on strings like "Report:").
- macOS `/tmp → /private/tmp` realpath mismatch in attachment save-path validation.
- Broader auth/connection error detection so IMAP disconnects evict the provider cache.

### Changed
- Consolidated duplicate `imap-auth` / `jmap-auth` modules into a shared `credentials.ts`.
- `AccountManager.getConfigDir()` replaces seven call sites that used a regex to derive the config directory from an account path (and broke on Windows).
- Rate-limit state is cleared when an account is removed.
- Tarball no longer ships `.github/workflows/` (added `files` field to `package.json`).

### Deps
- `@modelcontextprotocol/sdk` 1.28.0 → 1.29.0
- `imapflow` 1.2.18 → 1.3.2
- `nodemailer` 8.0.4 → 8.0.5

## 0.4.0 — 2026-04

Initial public release on npm.
