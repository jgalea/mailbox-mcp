# mailbox-mcp

Give your AI tools access to your email. Search, read, send, and manage messages across multiple accounts without leaving your terminal.

mailbox-mcp is an [MCP server](https://modelcontextprotocol.io) that connects your email to Claude Code, Cursor, Windsurf, or any AI tool that supports the Model Context Protocol. Instead of switching between your terminal and Gmail, you ask the AI to find that invoice, summarize a thread, or draft a reply — and it does.

**What makes this different from the 60+ other email MCP servers:**

- **Multiple accounts, one server.** Work email, personal email, client accounts — all accessible through a single server. No need to run separate instances.
- **Not just Gmail.** Supports Gmail (full API), any IMAP/SMTP provider (ProtonMail, corporate mail, self-hosted), and JMAP (Fastmail, Stalwart, Topicbox). Add providers without changing a line of tool code.
- **Actually secured.** 6 rounds of security auditing. Encrypted credentials (AES-256-GCM), prompt injection fencing on every email field, rate limiting, TLS enforcement, SSRF protection with IP encoding evasion detection, input validation. Most MCP servers skip security entirely.
- **36 tools.** Search, read, send, reply, forward, drafts, labels, filters, templates, signatures, vacation replies, attachments, unsubscribe, and more.
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

1. Download OAuth credentials from [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Save as `~/.mailbox-mcp/oauth-keys.json`
3. In Claude Code, run: `authenticate alias="personal" provider="gmail" email="you@gmail.com"`
4. Complete the OAuth flow in your browser

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
| `remove_account` | Remove an account |
| `search_emails` | Search messages |
| `read_email` | Read a message |
| `read_thread` | Read a conversation thread |
| `send_email` | Send a new email |
| `reply_email` | Reply to a message |
| `forward_email` | Forward a message |
| `create_draft` | Create a draft (supports reply drafts via `in_reply_to`) |
| `trash_emails` | Trash messages |
| `list_labels` | List labels/folders |
| `create_label` | Create a label/folder |
| `delete_label` | Delete a label/folder |
| `modify_email` | Modify message labels |
| `batch_modify_emails` | Bulk modify labels |
| `download_attachment` | Download an attachment |
| `inbox_summary` | Inbox overview |

### Gmail-Only

| Tool | Description |
|------|-------------|
| `create_filter` | Create a filter |
| `list_filters` | List filters |
| `delete_filter` | Delete a filter |
| `snooze_email` | Snooze a message |
| `list_snoozed` | List snoozed messages |
| `check_snoozed` | Check snoozed status |
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
| `search_contacts` | Search contacts |
| `list_send_as` | List send-as aliases |

## License

MIT

Built at [AgentVania](https://agentvania.com).
