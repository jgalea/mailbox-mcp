# mailbox-mcp

Give your AI tools access to your email. Search, read, send, and manage messages across multiple accounts without leaving your terminal.

mailbox-mcp is an [MCP server](https://modelcontextprotocol.io) that connects your email to Claude Code, Cursor, Windsurf, or any AI tool that supports the Model Context Protocol. Instead of switching between your terminal and Gmail, you ask the AI to find that invoice, summarize a thread, or draft a reply — and it does.

**What makes this different from the 60+ other email MCP servers:**

- **Multiple accounts, one server.** Work email, personal email, client accounts — all accessible through a single server. No need to run separate instances.
- **Not just Gmail.** Supports Gmail (full API), any IMAP/SMTP provider (ProtonMail, corporate mail, self-hosted), and JMAP (Fastmail, Stalwart, Topicbox). Add providers without changing a line of tool code.
- **Security-conscious.** Encrypted credentials (AES-256-GCM), prompt injection fencing on email content, rate limiting, TLS enforcement, SSRF protection with IP encoding evasion detection, input validation.
- **Tools for the workflows that matter.** Search, read, send, reply, forward, drafts, labels, filters, templates, signatures, vacation replies, attachments, unsubscribe, and more.
- **Zero native dependencies.** Pure Node.js. Install and run anywhere.

## Quick Start

### Install

```bash
git clone https://github.com/jgalea/mailbox-mcp.git
cd mailbox-mcp
npm install && npm run build
```

Then add to your Claude Code MCP config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "mailbox": {
      "command": "node",
      "args": ["/path/to/mailbox-mcp/dist/server.js"]
    }
  }
}
```

Replace `/path/to/mailbox-mcp` with the actual path where you cloned the repo.

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
authenticate alias="work" provider="imap" email="you@company.com" host="imap.company.com" smtpHost="smtp.company.com" username="you@company.com" password="your-app-password"
```

Credentials are encrypted at rest using AES-256-GCM.

### Add a JMAP Account

In Claude Code, run:

```
authenticate alias="fastmail" provider="jmap" email="you@fastmail.com" host="fastmail.com" username="you@fastmail.com" password="your-app-password"
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
| `send_email` | Send a new email (supports `attachments`) |
| `reply_email` | Reply to a message (supports `attachments`) |
| `forward_email` | Forward a message (supports `attachments`) |
| `create_draft` | Create a draft (supports reply drafts via `in_reply_to`, `attachments`) |
| `list_drafts` | List drafts for an account |
| `send_draft` | Send an existing draft |
| `trash_emails` | Trash messages |
| `mark_read` | Mark a message as read or unread |
| `star_email` | Star or unstar a message |
| `archive_email` | Archive a message (remove from inbox) |
| `list_labels` | List labels/folders |
| `create_label` | Create a label/folder |
| `delete_label` | Delete a label/folder |
| `modify_email` | Modify message labels |
| `batch_modify_emails` | Bulk modify labels |
| `count_unread_by_label` | Show unread message counts per label/folder |
| `download_attachment` | Download an attachment |
| `export_email` | Save a message as a `.eml` file |
| `export_thread` | Save every message in a thread as `.eml` files (Gmail + JMAP) |
| `emails_since` | List messages received after a given timestamp |
| `inbox_summary` | Inbox overview |

### Gmail-Only

| Tool | Description |
|------|-------------|
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

## Sending attachments

`send_email`, `reply_email`, `forward_email`, and `create_draft` accept an optional `attachments` parameter — an array of local file paths. The server reads each file, detects its MIME type from the extension, and embeds it in the outgoing message (or draft).

```
send_email account="personal" to=["friend@example.com"] subject="The report" body="See attached." attachments=["/path/to/report.pdf", "/path/to/chart.png"]
```

- Each file must be a regular file ≤ 25 MB; total per message is capped at 25 MB (Gmail's hard limit).
- Paths are resolved through any symlinks, and filenames are stripped of CRLF before going into headers.
- Gmail routes messages with attachments through the multipart upload endpoint (35 MB API limit) instead of the JSON endpoint, so the 25 MB message cap is the real ceiling.
- JMAP uploads each file to the server's upload URL first, then references the resulting blobIds in the Email/set call.

## License

MIT

Built at [AgentVania](https://agentvania.com).
