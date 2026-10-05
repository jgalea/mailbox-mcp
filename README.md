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

None of this makes prompt injection impossible. A model can still be talked into a reply you didn't want, and a text/plain part can say something different from the HTML part a human sees. Keep a human approving sends. A reasonable setup: `readOnly: true` on accounts you only need to search, an allowlist (or `draftsOnly`) on any account an agent sends from unattended, and the default confirmations everywhere else.

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

Each entry in `~/.mailbox-mcp/accounts.json` can carry four optional fields:

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
    "personal": { "provider": "gmail", "email": "me@example.com", "draftsOnly": true }
  }
}
```

| Field | Effect |
|-------|--------|
| `readOnly` | Every tool that isn't read-only refuses for this account with a clear error. Search, read, list and export still work. |
| `draftsOnly` | `send_email`, `reply_email`, `forward_email` and `send_template` create a draft instead and say so; `send_draft` refuses. The allowlist still applies; the confirmations and daily cap don't, since nothing leaves. |
| `allowedRecipients` | Exact addresses and `@domain` patterns (a domain pattern matches that domain only, not subdomains). Sends, replies, forwards and drafts to any other address are refused. |
| `dailySendLimit` | Sends allowed per rolling 24 hours (default 100; `0` blocks all sending). Counted from `sends.jsonl`, so restarts don't reset it. |

The same settings can be passed to `authenticate` as `read_only`, `drafts_only`, `allowed_recipients` and `daily_send_limit` when the account is created, and `list_accounts` shows them. There is deliberately no tool to change them afterwards: edit the file and restart the server. Malformed entries make the server refuse to start rather than run unguarded.

How "new recipient" is decided: an address is known if this server has sent to it before from that account (the `sends.jsonl` log), if it is the account's own address, or if one provider search (`from:addr OR to:addr`, limited to one result; INBOX only on IMAP) finds a message. Anything else needs `confirm_new_recipient: true`. Reply targets taken from the message being replied to are trusted, since you already received mail from them.

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
