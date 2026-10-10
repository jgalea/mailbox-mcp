<div align="center">

# mailbox-mcp

[![npm](https://img.shields.io/badge/NPM-mailbox--mcp-CB3837?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/mailbox-mcp)
[![License](https://img.shields.io/badge/LICENSE-MIT-5C9E31?style=for-the-badge)](LICENSE)
[![Built by](https://img.shields.io/badge/BUILT%20BY-AGENTVANIA-8A2BE2?style=for-the-badge)](https://agentvania.com)

**Give your AI tools access to your email. Search, read, send, and manage messages across multiple accounts without leaving your terminal.**

</div>

mailbox-mcp is an [MCP server](https://modelcontextprotocol.io) that connects your email to Claude Code, Cursor, Windsurf, or any AI tool that supports the Model Context Protocol. Instead of switching between your terminal and Gmail, you ask the AI to find that invoice, summarize a thread, or draft a reply — and it does.

**What makes this different from the 60+ other email MCP servers:**

- **Multiple accounts, one server.** Work email, personal email, client accounts — all accessible through a single server. No need to run separate instances.
- **Not just Gmail.** Supports Gmail (full API), any IMAP/SMTP provider (ProtonMail, corporate mail, self-hosted), and JMAP (Fastmail, Stalwart, Topicbox). Add providers without changing a line of tool code.
- **Built for untrusted input.** Hidden-text stripping, random-nonce fences, confirmations before mail leaves the account, per-account read-only and drafts-only modes, encrypted credentials (AES-256-GCM), TLS enforcement, SSRF protection. Details in [Security](#security).
- **Tools for the workflows that matter.** Search, read, send, reply, forward, drafts, labels, filters, templates, signatures, vacation replies, attachments, unsubscribe, and more.
- **Zero native dependencies.** Pure Node.js. Install and run anywhere.

## Security

Giving a model access to a mailbox means giving it access to text written by strangers. Any sender controls the subject, body, headers and attachment filenames of what the model reads, so the two risks are the model following instructions planted in an email, and the model sending mail somewhere it shouldn't (the usual goal of such instructions: forward the thread, reply with the contents of another message, mail a secret to an outside address). mailbox-mcp puts several layers between those two things.

**Fenced untrusted content.** Everything that came from an email is wrapped in `[UNTRUSTED_<KIND>_<nonce>] ... [/UNTRUSTED_<KIND>_<nonce>]` markers, and the server's MCP instructions tell the client that text inside them is data to report, never instructions to follow. The nonce is a random hex string chosen fresh for every tool response, so an email cannot close a fence early or open a fake one; anything in the content that even looks like a marker, in any case or with Unicode lookalike characters, has its bracket replaced before it reaches the model.

**Hidden text is removed, and you're told.** HTML-only messages are reduced to what a mail client would actually show. Elements hidden with `display:none`, `visibility:hidden`, `opacity:0`, zero or near-zero font sizes, text the same colour as its background (white on white), the `hidden` attribute, `aria-hidden`, off-screen positioning and the preheader `max-height:0; overflow:hidden` trick are dropped, along with comments, scripts, styles and templates. Zero-width and bidirectional control characters are stripped from every body, subject, header and filename. When anything was removed, the response ends with a visible warning saying how many characters went, so a message that says one thing to you and another to the model is flagged rather than silently cleaned.

**Confirmations before mail leaves.** Sending to an address the account has never sent to or received from needs `confirm_new_recipient: true`; the error lists the new addresses. Forwarding to a domain other than the account's own needs `confirm_external_forward: true`. The client is told to pass those flags only when you asked for that recipient yourself, never because an email did. Both checks are on by default.

**Per-account modes.** An account can carry a recipient allowlist (exact addresses and `@domain` patterns; everyone else is refused), a `draftsOnly` flag (send tools create a draft for you to review instead), and a `readOnly` flag (every write tool refuses; search and read keep working). These are set in `accounts.json` or when the account is created, and no tool can loosen them, so a hijacked session cannot switch them off. See [Account safety settings](#account-safety-settings).

**Tool annotations.** All 49 tools carry MCP `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint` annotations, so a client can auto-approve reads and always ask before anything that sends, deletes or changes settings.

**Caps and a log.** At most 10 sends per minute and, by default, 100 per rolling 24 hours per account; the daily count is kept on disk and survives restarts. Every send through the server is recorded in `~/.mailbox-mcp/sends.jsonl` with its recipients, and every bulk label or trash operation in `transactions.jsonl` with an undo id.

The three options below enforce limits outside the model instead of asking it to behave. All are off by default.

**Out-of-band approval** (`"approval": "external"` per account). Every send path still runs the guards above, then writes the fully resolved message to `~/.mailbox-mcp/pending/<id>.json` instead of sending it, and tells the model the id. No tool can list, edit or approve that queue. You do it in a terminal: `mailbox-mcp pending`, `mailbox-mcp show <id>`, `mailbox-mcp approve <id>`, `mailbox-mcp reject <id>`. `approve` prints the whole message, reads the confirmation from `/dev/tty` (not stdin, so it cannot be piped), re-runs the allowlist and daily cap, reloads attachments and refuses if one changed, then sends exactly what it printed. A shell without a controlling terminal, which is what an agent's shell is, cannot open `/dev/tty`, so it cannot approve its own sends. Entries expire after 7 days. See [Approving queued sends](#approving-queued-sends).

**Tool profiles** (`MAILBOX_MCP_PROFILE`). `read` exposes only read-only tools; `draft` exposes everything except the tools that can make mail leave the account. Hidden tools are absent from the tool list and refuse if called anyway. See [Choosing which tools load](#choosing-which-tools-load).

**Lock after untrusted reads** (`"untrustedReadLock": "approval" | "refuse"` per account). As soon as a tool shows the model a message it cannot vouch for, or exports or downloads message content to disk, the account is marked for the rest of the server process. `approval` then routes every send from it through the pending queue even if `approval` isn't set; `refuse` refuses sends until the server restarts. No argument the model can pass lifts it. The lock is strict by design: a message is vouched for only when its sender is on the account's `trustedSenders` list in `accounts.json` AND the receiving server's DMARC check passed for the From domain. Nothing a sender or the model can influence counts: not the From header, not the Sent folder, not the send log, not a mailbox search. With no `trustedSenders` configured, reading any third-party mail taints, which is the intended default; most people will want `approval: "external"` rather than a long trusted list. See [How the lock decides](#how-the-lock-decides).

None of this makes prompt injection impossible. A model can still be talked into a reply you didn't want, and a text/plain part can say something different from the HTML part a human sees. Keep a human approving sends. A reasonable setup: `readOnly: true` or `MAILBOX_MCP_PROFILE=read` on accounts you only need to search, `approval: "external"` or an allowlist on any account an agent sends from unattended, `untrustedReadLock` on anything that triages an inbox, and the default confirmations everywhere else.

## Quick Start

### Install

Add to your Claude Code MCP config (`~/.claude.json`). The package runs straight from npm via `npx`:

```json
{
  "mcpServers": {
    "mailbox": {
      "command": "npx",
      "args": ["-y", "mailbox-mcp"],
      "env": {
        "MAILBOX_MCP_PASSPHRASE": "a-long-random-passphrase"
      }
    }
  }
}
```

`MAILBOX_MCP_PASSPHRASE` is the passphrase used to encrypt IMAP/JMAP credentials at rest; it's required before adding an IMAP or JMAP account, and unused for Gmail-only setups. `MAILBOX_MCP_CONFIG_DIR` moves the config directory somewhere other than `~/.mailbox-mcp`.

<details>
<summary>From source instead</summary>

```bash
git clone https://github.com/jgalea/mailbox-mcp.git
cd mailbox-mcp
npm install && npm run build
```

Then point the config at the build with `"command": "node", "args": ["/path/to/mailbox-mcp/dist/server.js"]`.
</details>

### Add a Gmail Account

#### 1. Create a Google Cloud project

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a new project
2. Enable the **Gmail API**: [APIs & Services > Library > Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) > Enable

#### 2. Set up OAuth consent screen

1. Go to [Google Auth Platform > Branding](https://console.cloud.google.com/auth/branding)
2. Set **App name** and **User support email**
3. Go to [Audience](https://console.cloud.google.com/auth/audience), select **External**
4. Add the Google account you'll sign in with as a **test user** (this must be the exact `@gmail.com` address you use to authenticate, not a workspace alias)

#### 3. Create OAuth credentials

1. Go to [Google Auth Platform > Clients](https://console.cloud.google.com/auth/clients) > Create Client
2. **Application type**: Desktop app
3. Click **Create**
4. Go to [APIs & Services > Credentials](https://console.cloud.google.com/apis/credentials), find your client, and click the download icon to get the JSON
5. Save the file as `~/.mailbox-mcp/oauth-keys.json`

#### 4. Authenticate

In Claude Code, run: `authenticate alias="personal" provider="gmail" email="you@gmail.com"`

This opens a browser window to complete the OAuth flow. Your tokens are stored locally in `~/.mailbox-mcp/accounts/`.

### Add an IMAP Account

In Claude Code, run:

```
authenticate alias="work" provider="imap" email="you@company.com" host="imap.company.com" smtpHost="smtp.company.com" username="you@company.com" password="<app-password>"
```

Credentials are encrypted at rest using AES-256-GCM.

### Add a JMAP Account

In Claude Code, run:

```
authenticate alias="fastmail" provider="jmap" email="you@fastmail.com" host="fastmail.com" username="you@fastmail.com" password="<app-password>"
```

JMAP auto-discovers the API endpoint via `.well-known/jmap`. Credentials are encrypted at rest using AES-256-GCM.

**Supported JMAP servers:** Fastmail, Stalwart, Topicbox, Cyrus IMAP, and any RFC 8620-compliant server.

**JMAP advantages over IMAP:**
- Native thread support (real conversations, not synthetic)
- Server-side search (faster, more accurate)
- Batch operations in a single HTTP request
- No persistent connection required

## Tools

### Universal (Gmail + IMAP + JMAP)

| Tool | Description |
|------|-------------|
| `list_accounts` | List configured accounts |
| `authenticate` | Add a new account |
| `reauth` | Re-run OAuth for an existing Gmail account (use when refresh token expires with `invalid_grant`) |
| `remove_account` | Remove an account |
| `search_emails` | Search messages (optional `folder` to scope the search) |
| `multi_account_search` | Run the same query across every configured account in parallel |
| `read_email` | Read a message |
| `read_thread` | Read a conversation thread (Gmail + JMAP) |
| `send_email` | Send a new email (supports `from`, `attachments`; new recipients need `confirm_new_recipient`) |
| `reply_email` | Reply to a message (supports `from`, `attachments`; extra cc/bcc to new addresses need `confirm_new_recipient`) |
| `forward_email` | Forward a message (supports `from`, `attachments`; other domains need `confirm_external_forward`) |
| `create_draft` | Create a draft (supports reply drafts via `in_reply_to`, plus `from`, `attachments`) |
| `list_drafts` | List drafts for an account |
| `send_draft` | Send an existing draft (same recipient guards as `send_email`) |
| `trash_emails` | Trash messages |
| `mark_read` | Mark a message as read or unread |
| `star_email` | Star or unstar a message |
| `archive_email` | Archive a message (remove from inbox) |
| `list_labels` | List labels/folders |
| `create_label` | Create a label/folder |
| `delete_label` | Delete a label/folder |
| `modify_email` | Modify message labels |
| `batch_modify_emails` | Bulk modify labels |
| `bulk_modify` | Add/remove labels on every message matching a query (search-then-batch; `dry_run` supported) |
| `bulk_trash` | Trash every message matching a query (`dry_run` supported) |
| `list_recent_bulk_ops` | List recorded bulk operations from the transaction log |
| `undo_bulk_op` | Reverse a recorded bulk operation against the exact ids it touched |
| `count_unread_by_label` | Show unread message counts per label/folder |
| `download_attachment` | Download an attachment |
| `export_email` | Save a message as a `.eml` file |
| `export_thread` | Save every message in a thread as `.eml` files (Gmail + JMAP) |
| `emails_since` | List messages received after a given timestamp |
| `inbox_summary` | Inbox overview |

### Gmail-Only

| Tool | Description |
|------|-------------|
| `update_draft` | Replace the contents of an existing draft (thread association preserved) |
| `delete_draft` | Permanently delete a draft |
| `create_filter` | Create a filter |
| `list_filters` | List filters |
| `delete_filter` | Delete a filter |
| `save_template` | Save a template |
| `list_templates` | List templates |
| `delete_template` | Delete a template |
| `send_template` | Send from template |
| `get_signature` | Get signature |
| `set_signature` | Update signature |
| `get_vacation` | Get vacation settings |
| `set_vacation` | Configure vacation reply (supports date ranges, domain-only) |
| `unsubscribe` | Find unsubscribe link |
| `bulk_unsubscribe` | Bulk unsubscribe |
| `list_send_as` | List send-as aliases |

## Account safety settings

Each entry in `~/.mailbox-mcp/accounts.json` can carry eight optional fields:

```json
{
  "accounts": {
    "archive": { "provider": "gmail", "email": "old@example.com", "readOnly": true },
    "agent": {
      "provider": "imap", "email": "bot@example.com",
      "host": "imap.example.com", "port": 993, "smtpHost": "smtp.example.com", "smtpPort": 587,
      "allowedRecipients": ["ops@example.com", "@example.com"],
      "dailySendLimit": 20
    },
    "personal": { "provider": "gmail", "email": "me@example.com", "draftsOnly": true },
    "work": { "provider": "gmail", "email": "me@work.example", "approval": "external", "untrustedReadLock": "approval" },
    "triage": { "provider": "gmail", "email": "inbox@example.com", "untrustedReadLock": "refuse", "trustedSenders": ["boss@example.com", "@partner.example"] }
  }
}
```

| Field | Effect |
|-------|--------|
| `readOnly` | Every tool that isn't read-only refuses for this account with a clear error. Search, read, list and export still work. |
| `draftsOnly` | `send_email`, `reply_email`, `forward_email` and `send_template` create a draft instead and say so; `send_draft` refuses. The allowlist still applies; the confirmations and daily cap don't, since nothing leaves. Takes precedence over `approval`. |
| `allowedRecipients` | Exact addresses and `@domain` patterns (a domain pattern matches that domain only, not subdomains). Sends, replies, forwards and drafts to any other address are refused. |
| `dailySendLimit` | Sends allowed per rolling 24 hours (default 100; `0` blocks all sending). Counted from `sends.jsonl`, so restarts don't reset it. |
| `approval` | `"external"`: `send_email`, `reply_email`, `forward_email`, `send_draft` and `send_template` run every guard, then queue the message under `~/.mailbox-mcp/pending/` instead of sending. Only `mailbox-mcp approve <id>` in a terminal sends it. |
| `untrustedReadLock` | `"approval"` or `"refuse"`. Once any tool has shown this session a message that is not DMARC-authenticated mail from a `trustedSenders` entry, or exported message content to disk, sends from the account are queued for approval or refused until the server restarts. In-memory only; nothing the model calls can clear it. |
| `trustedSenders` | Exact addresses and `@domain` patterns whose mail the lock may trust, and only when it passes DMARC. Empty or absent means every third-party message taints. Only settable in `accounts.json`; `authenticate` never takes it. |
| `authservId` | The `authserv-id` your own mail server writes into the topmost `Authentication-Results` header (Gmail: `mx.google.com`, set automatically). IMAP and JMAP accounts need it before the lock can trust any received mail; without it every third-party message taints. Only settable in `accounts.json`. |

The same settings can be passed to `authenticate` as `read_only`, `drafts_only`, `allowed_recipients`, `daily_send_limit`, `approval` and `untrusted_read_lock` when the account is created, and `list_accounts` shows them. There is deliberately no tool to change them afterwards: edit the file and restart the server. Malformed entries make the server refuse to start rather than run unguarded.

### Approving queued sends

The same binary that runs the server is the approval CLI. With no arguments it starts the MCP server; with a command it works the queue and exits.

```
mailbox-mcp pending        # id, account, from, recipients, subject, created, attachment names
mailbox-mcp show <id>      # the full message
mailbox-mcp approve <id>   # prints the message, asks "Type yes to send", sends exactly that
mailbox-mcp reject <id>    # drops it
```

If you installed with `npx`, run `npx mailbox-mcp pending` and so on. The config directory is the same one the server uses (`MAILBOX_MCP_CONFIG_DIR`, default `~/.mailbox-mcp`), so set it the same way if you changed it.

`approve` reads the confirmation from `/dev/tty`, never stdin, and refuses with a clear error when it cannot open it. That is what stops an agent with shell access from approving its own sends: its shell has no controlling terminal. What it prints is what it sends: the entry is read once into memory through a descriptor that refuses symlinks, and the file's hash is checked again right before sending. A message containing terminal escapes, bidirectional overrides or zero-width characters, which could make the screen show something other than what goes out, is refused outright. At approval time it re-runs the allowlist and daily cap against the current `accounts.json`, reloads every attachment from the path recorded at queue time and refuses if the file is gone or its size changed, records the send in `sends.jsonl` like any other, and deletes the pending file. Entries older than 7 days are refused; reject them to clean up. The pending directory is created `0700` and files `0600`.

For reply and forward, the queued body is your text; threading headers and the forwarded original are added by the provider at send time, as `show` says. For `send_draft` the queue holds the draft id, its recipients and a fingerprint of the draft as it was; `approve` refuses if the draft or its recipients changed since, so an `update_draft` after queueing cannot ride on an earlier review. Review the body in your mail client.

If the agent runs inside Claude Code, add the approve command to the deny list in `.claude/settings.json` so even a permission prompt never offers it:

```json
{ "permissions": { "deny": ["Bash(mailbox-mcp approve*)", "Bash(npx mailbox-mcp approve*)"] } }
```

How "new recipient" is decided: an address is known if this server has sent to it before from that account (the `sends.jsonl` log), if it is the account's own address, or if one provider search (`from:addr OR to:addr`, limited to one result; INBOX only on IMAP) finds a message. Anything else needs `confirm_new_recipient: true`. Reply targets taken from the message being replied to are trusted, since you already received mail from them.

`authenticate` refuses an alias that already exists, with or without safety settings, so a session cannot swap the address, provider or host under them; `reauth` refreshes a Gmail token without touching the config. `remove_account` refuses for any account that has a safety setting, since removing and re-adding it would drop them. Both point at `accounts.json`. Nothing the model can call may write into the config or log directory either: `export_email`, `export_thread` and `download_attachment` refuse a `save_to` inside them (even when that directory sits under `/tmp`, is spelled in a different case on a case-insensitive filesystem, or is reached through a symlink), write only to the canonical directory they validated, check it again once it exists, and never write through a symlink planted under the file name; the `attachments` of a send refuse to read from those directories by the same rules. So the approval queue, `accounts.json`, the send log and stored credentials stay out of reach. Every recipient of a send must be one plain address; a value carrying two addresses is refused rather than checked as its first one.

### How the lock decides

`untrustedReadLock` treats a message as trusted only when all of the following hold. The From header reduces to exactly one plain address (several addresses, a display name with its own angle brackets or `@`, invisible characters or no address at all fail this). That address matches an entry in the account's `trustedSenders` (exact address or `@domain`, domain only, not subdomains). The topmost `Authentication-Results` header was written by the account's own server (`authserv-id` equals `authservId`, `mx.google.com` for Gmail), contains exactly one `dmarc=` result, that result is `pass`, and its `header.from` equals the From domain. Everything else taints: any sender not on the list, a listed sender whose mail did not pass DMARC, the account's own address (unless listed), mail from a server you have not named in `authservId`, any tool that cannot supply the header for a message, and any error while deciding. The Sent folder, the local send log and mailbox searches play no part, because labels and folders can be changed by a tool call and a search can be fed by a crafted message. Exports and downloads taint unconditionally because the content leaves the fence.

## Choosing which tools load

49 tool schemas cost roughly 6,000 tokens in clients that load every definition into context. In everyday use a handful of tools do most of the work, so you can expose only the groups you need with `MAILBOX_MCP_TOOLS` (comma-separated). Unset means everything loads.

```json
"env": {
  "MAILBOX_MCP_TOOLS": "core,attachments"
}
```

| Group | Tools | What it covers |
|-------|-------|----------------|
| `core` | 19 | accounts, search, read, send, reply, forward, drafts, inbox summary (~2,900 tokens) |
| `organize` | 9 | labels, star, archive, trash, modify |
| `bulk` | 4 | query-wide modify/trash with dry-run and undo |
| `attachments` | 3 | download attachments, export `.eml` |
| `gmail-extras` | 14 | filters, templates, signatures, vacation, unsubscribe, send-as |

Calls to tools in disabled groups fail with an error naming the group to enable.

### Tool profiles

`MAILBOX_MCP_PROFILE` picks what kind of instance this is. It composes with `MAILBOX_MCP_TOOLS`: a tool loads only when both allow it. Hidden tools are missing from the tool list and refuse if called anyway, with an error naming the profile. An unknown value stops the server at startup.

| Profile | Tools |
|---------|-------|
| `full` (default) | everything, as before |
| `draft` | everything except the ten below |
| `read` | only tools annotated `readOnlyHint: true` (the 18 search, read, list and get tools, `unsubscribe` and `bulk_unsubscribe` included since they only return links) |

`draft` hides, because each can make mail leave the account or change what future mail says to a third party: `send_email`, `reply_email`, `forward_email`, `send_draft`, `send_template` (they send), `create_filter` (Gmail filters can forward and auto-file), `set_vacation` (sends auto-replies), `set_signature` (text injected into every future message you send), `unsubscribe` and `bulk_unsubscribe` (they surface attacker-chosen unsubscribe targets to act on). Drafts, labels, archiving, trash, bulk operations with undo, downloads and exports all stay available.

```json
"env": { "MAILBOX_MCP_PROFILE": "draft", "MAILBOX_MCP_TOOLS": "core,attachments" }
```

## Inbox triage with Jev (optional)

Set `MAILBOX_MCP_TYPESAFE_API_KEY` (or `TYPESAFE_API_KEY`) to a key from [TypeSafe](https://console.typesafe.ai/keys) and `inbox_summary` labels each recent message: needs reply, FYI, newsletter, receipt, notification or suspicious, plus urgent when the sender needs something within about a day, with a confidence figure.

```json
"env": { "MAILBOX_MCP_TYPESAFE_API_KEY": "your-key" }
```

Jev is a decision model: it can only pick from the fixed options above, so text in an email can't steer it into doing anything else. Labels come from those fixed options, never from email text, and are printed outside the untrusted-content fence.

This sends each message's sender, subject and snippet (capped at 2,000 characters) to TypeSafe's API. Leave the key unset and nothing is sent; the tool behaves exactly as before. Up to 25 messages are triaged per call; any that fail are reported as unclassified rather than guessed.

## Sending attachments

`send_email`, `reply_email`, `forward_email`, and `create_draft` accept an optional `attachments` parameter — an array of local file paths. The server reads each file, detects its MIME type from the extension, and embeds it in the outgoing message (or draft).

```
send_email account="personal" to=["friend@example.com"] subject="The report" body="See attached." attachments=["/path/to/report.pdf", "/path/to/chart.png"]
```

- Each file must be a regular file ≤ 25 MB; total per message is capped at 25 MB (Gmail's hard limit).
- Paths are resolved through any symlinks, and filenames are stripped of CRLF before going into headers.
- Gmail routes messages with attachments through the multipart upload endpoint (35 MB API limit) instead of the JSON endpoint, so the 25 MB message cap is the real ceiling.
- JMAP uploads each file to the server's upload URL first, then references the resulting blobIds in the Email/set call.

## Choosing the sender address

One account often speaks for several addresses. `send_email`, `reply_email`, `forward_email`, `create_draft`, and `update_draft` accept an optional `from` parameter; without it, the account's primary address is used.

```
reply_email account="personal" message_id="18f..." from="jean@example.com" body="Thanks, sorted."
```

Accepted forms are `alias@example.com` and `Name <alias@example.com>`; matching is case-insensitive.

The address is checked against the account before anything is sent, and the call fails with the list of usable addresses if it doesn't match. This matters because Gmail silently falls back to the primary address when the `From` header names an address you haven't verified, so a message can be sent from the wrong identity and still look like it succeeded. Some recipients (Amazon's customer service, for one) reject mail that doesn't come from the address on file.

- Gmail: the address must be a send-as alias with verification completed. Run `list_send_as` to see them. Pending aliases are refused.
- JMAP: the address must match one of the account's identities; its `identityId` is attached to the submission.
- IMAP: no alias list exists to check against, so any `from` is passed to the SMTP relay, which accepts or rejects it at send time.

## License

MIT

Built at [AgentVania](https://agentvania.com).
