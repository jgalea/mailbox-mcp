# Changelog

## 0.10.0 — 2026-07-12

### Added
- **`from` parameter on every send path.** `send_email`, `reply_email`, `forward_email`, `create_draft`, and `update_draft` now accept `from`, so an account with several addresses can pick which one it speaks as. Previously the sender was whatever the provider defaulted to: the Gmail path never emitted a `From` header at all (so Gmail used the primary address), while IMAP and JMAP hardcoded the account address. `buildRawMimeMessage` already supported `from`; nothing upstream ever passed it. Accepts `alias@example.com` or `Name <alias@example.com>`, matched case-insensitively.
- **The address is validated before the message goes out.** Gmail quietly rewrites the `From` header to the primary address when it names an unverified alias, so sending as the wrong identity looked like a clean success. Gmail now checks the address against the account's send-as list (rejecting `pending` aliases) and JMAP against its identities, and both fail with the addresses that would have worked. IMAP has no alias list, so `from` is passed to the SMTP relay to accept or reject.

### Added
- **`MAILBOX_MCP_TOOLS` — load only the tool groups you use.** All 49 schemas weigh ~6k tokens in clients that eager-load definitions, while real transcripts show a handful of tools doing most of the work. Tools are now grouped (`core`, `organize`, `bulk`, `attachments`, `gmail-extras`) and the env var takes a comma-separated list of groups to expose; `core` alone is 19 tools at roughly half the payload. Unset keeps the previous expose-everything behaviour. Disabled tools also refuse calls with an error naming the group.

### Fixed
- **`update_draft` crashed with `part.body.pipe is not a function` when the draft had attachments.** The multipart media upload was handed the raw MIME `Buffer`, but googleapis pipes the media body and expects a stream. Every other media-upload path already wrapped the buffer in `Readable.from()`; `update_draft` was the one that didn't. Regression-tested.
- **JMAP submissions did not carry an `identityId`.** `EmailSubmission/set` left the server to guess the sending identity, which is what made a non-default sender impossible. The resolved identity's id is now attached to the submission, and `urn:ietf:params:jmap:submission` was added to the `using` list it should always have declared.

## 0.9.2 — 2026-06-17

### Security
- **Passphrase is now environment-only.** The `authenticate` tool no longer accepts a `passphrase` parameter; the encryption passphrase must come from `MAILBOX_MCP_PASSPHRASE`. Tool arguments are serialized into MCP host logs and model context, so accepting a secret there leaked it. The env-var path was already the recommended one.
- **Attachment and `.eml` filenames are forced to a single path component.** Download/export now run `basename()` on the provider-supplied filename before joining it to the save directory, so a malicious or compromised mail server can't steer the write into a subdirectory via a `filename` like `subdir/evil`.

### Fixed
- **"Keeps disconnecting" when the terminal is detached or Claude is interrupted.** The signal handlers exited the process on `SIGHUP` and `SIGINT`. Those signals reach the server only because the harness spawns it inside its controlling-terminal process group, so detaching zellij, closing the terminal window, or hitting Ctrl-C/interrupt delivered them as collateral and killed a server the session still wanted. The lifecycle log showed nothing wrong (`signal SIGHUP` then `exit code=0`), so it looked like a clean shutdown. The server now ignores `SIGHUP`/`SIGINT` and relies on the harness's authoritative shutdown paths instead: stdin EOF (guaranteed when the parent goes away), `SIGTERM`, and the reparent watchdog. Covered by `tests/signal-resilience.test.ts`.
- **Intermittent mid-session disconnects forcing a manual `/mcp` reconnect.** The `process.stdout`/`process.stdin` error handlers called `process.exit(0)` on *any* stream error. Transient backpressure errors (`EAGAIN`/`EWOULDBLOCK`), which Node surfaces on a busy pipe while flushing a large `search_emails`/`read_email` response, were treated as fatal — the server exited cleanly (`exit code=0`, so nothing looked wrong in the lifecycle log) and the client saw a dropped transport. Stream errors are now classified: only a genuinely broken pipe (`EPIPE`, `ECONNRESET`, `ERR_STREAM_DESTROYED`, `ERR_STREAM_WRITE_AFTER_END`) exits; transient errors are logged (`stdin-error-transient`/`stdout-error-transient`) and the server keeps serving. `shutdownClean` is now idempotent so overlapping `end`/`close`/`error` events can't double-fire the drain timer.
- **IMAP `messageId` operations targeted the wrong message on mailboxes with expunged history.** `messageMove`, `messageFlagsAdd`, `messageFlagsRemove`, and `fetchOne` were called without the `{ uid: true }` options argument, so imapflow treated the stored UID as a sequence number. The two `uid` flags in imapflow are distinct: the one inside the *query object* (e.g. `{ envelope: true, uid: true }`) asks the response to include the UID; the one inside the *options object* (3rd arg) tells imapflow to treat the input range as a UID. We had the first but not the second. Affected `read_email`, `modify_email`, `mark_read`, `star_email`, `archive_email`, `trash_emails`, `download_attachment`, `send_draft`, `export_email`, `inbox_summary`, and `list_drafts`. (Originally reported in #2 by @benv666.)
- **`modify_email` rejected the cross-provider label vocabulary on IMAP.** `UNREAD` and `STARRED` are the names Gmail (and the generic `MailProvider` callers) use; on IMAP they map to `\Seen` (inverted) and `\Flagged`. Previously `assertFlagName` threw on anything outside the system-flag set, so `modify_email({add_labels:["UNREAD"]})` or `markRead(false)` against the abstract provider failed. New `resolveImapFlags` helper translates `UNREAD` (with inversion against `\Seen`) and `STARRED` (→ `\Flagged`), and canonicalises standard flags to title case (`\Flagged`, `\Seen`, …). (Originally reported in #4 by @benv666.)
- **IMAP `search_emails` and `messages_since` returned wrong rows on mailboxes with expunged history.** `ImapProvider.searchByText` and `ImapProvider.messagesSince` called `imap.search(...)` without `{ uid: true }`, so imapflow returned sequence numbers. Those numbers were then passed to `fetchAll(...)` (also without `{ uid: true }`), so the whole pipeline was seq-based and worked only by coincidence — on mailboxes where seq nums happened to overlap with UIDs. Mid-query expungement or any non-dense UID space broke it. Both call sites now pass `{ uid: true }` to `search` and `fetchAll`. Also fixed the wildcard branch of `searchMessages`, whose `fetchAll` was missing the same options-level flag (caught by the same root-cause sweep). (Originally reported in #9 by @zentrolink-ivanzhukov; tracked in #10.)
- **IMAP `inbox_summary` reported stale unread counts.** The previous implementation read `mailbox.unseen` from imapflow's internal mailbox object, which is populated at SELECT time and never refreshed. Marking messages read/unread, IDLE updates, and concurrent changes from other clients didn't touch it — the count could be arbitrarily stale on long-lived sessions. Now counted fresh via `imap.search({ seen: false })` against the locked mailbox. (Originally reported in #7 by @benv666.)

### Changed
- **IMAP `modify_email` passes unknown labels through as IMAP keywords** instead of throwing. RFC 3501 §2.3.2 explicitly permits server- and user-defined keywords alongside system flags, and imapflow forwards them. This makes the IMAP provider useful for workflows depending on custom keywords (`$Junk`, `NonJunk`, project tags) and matches the cross-provider abstraction's pass-through behaviour for other providers. Callers that relied on the old throw-on-unknown for input validation should validate their label names before calling.

## 0.9.1 — 2026-05-06

### Fixed
- **Silent disconnect on `count_unread_by_label`.** Same anti-pattern as the 0.8.0 `searchMessages` fix: per-label `labels.get` calls were sequential, so accounts with many labels (50-100+) took 17-82s and exceeded Claude Code's MCP request timeout. The client tore down the transport without leaving a transport-close / stdin-end / signal in the lifecycle log. `GmailProvider.countUnreadByLabel` now fans out at concurrency 20; `ImapProvider.countUnreadByLabel` at concurrency 8 (more conservative for IMAP `STATUS` round-trips). JMAP was already a single batch call and unaffected.

## 0.9.0 — 2026-04-25

### Added
- **Reversible bulk operations.** `bulk_modify` and `bulk_trash` now write a transaction record (timestamp, account, query, label changes, message ids) to `~/.mailbox-mcp/transactions.jsonl` before returning. Each response includes the `op_id` so the user can reverse immediately if the result was wrong.
- **`list_recent_bulk_ops`** — paginated list of recorded bulk ops, optionally filtered by account, with reversed-status flags so an op can't be reversed twice.
- **`undo_bulk_op`** — replays the inverse label change against the exact ids that were touched. Archive (remove INBOX) becomes add INBOX; trash (add TRASH) becomes remove TRASH. Idempotent — refuses to re-reverse an op already marked reversed.
- `MAILBOX_MCP_LOG_DIR` env var overrides the log directory (used by tests; production uses `~/.mailbox-mcp/`).

### Notes
- Transactions are not recorded for `dry_run` calls.
- Log file rotates at 50MB. Records hold full id arrays, so a 2k-id archive op writes ~70KB.

## 0.8.0 — 2026-04-24

### Fixed
- **Silent disconnect on large `search_emails` pages.** Per-message metadata `get` calls were sequential, so a `max_results=500` page took ~25s and exceeded Claude Code's MCP request timeout. The client closed the transport without notifying the server (no `transport-close`, no `stdin-end`, no signal — the 0.7.0 lifecycle log was therefore silent on the cause). `GmailProvider.searchMessages` now fans the gets out at concurrency 20, cutting a 500-id page from ~25s to ~1.5s.

### Added
- **`bulk_modify`** — search-and-modify in one call. Same fast `findMessageIds` + `batchModifyLabels` path as `bulk_trash` (introduced in 0.7.0), but for arbitrary label ops. Use `remove_labels=["INBOX"]` for archive, `add_labels=["STARRED"]` for bulk star, etc. Avoids the slow `search_emails` round-trip entirely for these workflows.
- **Per-request lifecycle logging.** Every tool call now writes `call-start`/`call-end`/`call-error` lines to `~/.mailbox-mcp/debug.log` with request id, tool name, duration in ms, and response size in bytes. Combined with a 60s `alive` heartbeat, future silent disconnects can be diagnosed: a missing `call-end` after `call-start` plus continuing `alive` beats means the request handler hung; a stop in heartbeats means the process actually died.

## 0.7.0 — 2026-04-24

### Added
- **`bulk_trash`** — search-and-trash in one call. Takes a query (Gmail syntax for Gmail accounts) plus optional `folder` scope, `dry_run` flag, and `max` safety cap, paginates the search, and trashes all matching ids via `trashMessages`. Solves the "I want to nuke a whole label" workflow without a manual search → collect → trash dance.
- **`MailProvider.findMessageIds(query, folder?, maxResults?)`** — id-only paginated search. Returns just the matching message ids without the per-message metadata fetch that `searchMessages` does, so it can scale to thousands of results cheaply. Gmail uses `users.messages.list` with `pageToken` (500-id pages, capped at `maxResults` when provided); IMAP and JMAP delegate to `searchMessages` and project to ids.

## 0.6.3 — 2026-04-23

### Added
- Lifecycle logging at `~/.mailbox-mcp/debug.log` (mode 0600, 1MB rotation). Records `start`, `transport-close`, `transport-error`, `stdin-end`, `signal`, `exit`, `unhandledRejection`, `uncaughtException`, `fatal`. Silent disconnects now leave a paper trail so the next occurrence can be diagnosed instead of guessed at. Tokens are redacted via the existing `redactTokens` helper before being written.

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
