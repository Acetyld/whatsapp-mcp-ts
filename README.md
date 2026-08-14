# WhatsApp MCP Server (TypeScript/Baileys)
[![smithery badge](https://smithery.ai/badge/@jlucaso1/whatsapp-mcp-ts)](https://smithery.ai/server/@jlucaso1/whatsapp-mcp-ts)

This is a Model Context Protocol (MCP) server for WhatsApp, built with TypeScript, Bun, and `@whiskeysockets/baileys`.

It lets you connect **multiple personal WhatsApp accounts** (named sessions) to an AI agent (Claude Desktop, Cursor, etc.) so the agent can:

* Create, list, inspect, and delete WhatsApp sessions
* Search messages and contacts for a given session
* List chats and retrieve message history
* Send messages to individuals or groups

Each session uses WhatsApp Web multi-device auth stored under `./auth_info/<session_id>/`. All sessions share one local SQLite database (`./data/whatsapp.db`) via Bun's native SQLite driver and Drizzle ORM. Data is only sent to the connected AI agent when it explicitly uses MCP tools.

## Example

**User:**
Send a WhatsApp message from my "personal" session to "Meu amor" saying "Te amo"

---

**Assistant:**
I'll list sessions, then find the contact and send the message.
*Using tool: `whatsapp.list_sessions`*

---

**Tool Result:**
```json
[
  {
    "session_id": "a1b2c3d4-...",
    "name": "personal",
    "status": "connected",
    "phone_jid": "5599xxxxxx@s.whatsapp.net"
  }
]
```

---

**Assistant:**
*Using tool: `whatsapp.search_contacts`*
```json
{
  "session_id": "a1b2c3d4-...",
  "query": "Meu amor"
}
```

---

**Tool Result:**
```json
[
  {
    "jid": "5599xxxxxx@s.whatsapp.net",
    "name": "Meu Amor"
  }
]
```

---

**Assistant:**
*Using tool: `whatsapp.send_message`*
```json
{
  "session_id": "a1b2c3d4-...",
  "recipient": "5599xxxxxx@s.whatsapp.net",
  "message": "Te amo"
}
```

## Key Features (MCP Tools)

### Session management
* `create_session`: Create a named WhatsApp session (starts QR login in the background; returns `session_id` and optional `qr_url`)
* `list_sessions`: List all sessions with status / phone JID
* `get_session`: Get one session (includes latest `qr_url` while pending)
* `delete_session`: Disconnect, remove auth files, and delete that session's DB rows

### Messaging / data (all require `session_id`)
* `search_contacts`
* `list_messages`
* `list_chats`
* `get_chat`
* `get_message_context`
* `send_message`
* `search_messages`

## Installation

### Installing via Smithery

```bash
npx -y @smithery/cli install @jlucaso1/whatsapp-mcp-ts --client claude
```

### Prerequisites

* **Bun:** 1.1+ (`bun -v`)
* **AI Client:** Anthropic Claude Desktop, Cursor, Cline, or Roo Code (or another MCP-compatible client)

### Steps

1.  **Clone this repository:**
    ```bash
    git clone <your-repo-url> whatsapp-mcp-ts
    cd whatsapp-mcp-ts
    ```

2.  **Install dependencies:**
    ```bash
    bun install
    ```

3.  **Run the server:**
    ```bash
    bun src/main.ts
    ```
    * The MCP server starts immediately (no WhatsApp login required at boot).
    * Use `create_session` with a **name** from your AI client (or a smoke test) to start linking a WhatsApp account.
    * Scan the QR code from the returned / `get_session` `qr_url` (or the browser tab that may open via quickchart.io).
    * Auth is stored in `auth_info/<session_id>/`; message data for all sessions lives in `./data/whatsapp.db`.

> **Breaking change:** Older single-session `auth_info/` and unscoped SQLite schemas are not migrated automatically. Delete old `auth_info/` and `data/` (or start fresh) when upgrading.

## Configuration for AI Client

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "bun",
      "args": [
        "{{PATH_TO_REPO}}/src/main.ts"
      ],
      "cwd": "{{PATH_TO_REPO}}",
      "timeout": 30,
      "disabled": false
    }
  }
}
```

* **Claude Desktop:** `claude_desktop_config.json` in the Claude config directory
* **Cursor:** `~/.cursor/mcp.json` (or project `.cursor/mcp.json`)

Restart the AI client after saving.

## Usage

1. Call `create_session` with a name (e.g. `"personal"`).
2. If status is `pending_qr`, open `qr_url` / `get_session` and scan with WhatsApp → Linked Devices.
3. When status is `connected`, call messaging tools with that `session_id`.
4. Repeat for additional accounts (each needs its own session name).

On restart, sessions with saved credentials under `auth_info/<session_id>/` are restored automatically.

## Architecture Overview

Single Bun process that:

1. Exposes MCP tools over stdio (`@modelcontextprotocol/sdk`)
2. Manages multiple Baileys sockets (one per session) via a session manager
3. Stores all session metadata + chats/messages/contacts in one shared SQLite DB (`bun:sqlite` + Drizzle ORM)
4. Logs with pino (`wa-logs.txt`, `mcp-logs.txt`)

## Data Storage & Privacy

* **Auth:** `./auth_info/<session_id>/` (gitignored)
* **DB:** `./data/whatsapp.db` — shared across sessions, rows scoped by `session_id` (gitignored)
* **LLM:** Data is only sent when the agent calls MCP tools

## Technical Details

* **Language:** TypeScript
* **Runtime:** Bun (>= 1.1)
* **WhatsApp API:** `@whiskeysockets/baileys`
* **MCP SDK:** `@modelcontextprotocol/sdk`
* **Database:** `bun:sqlite` + `drizzle-orm`
* **Logging:** `pino`
* **Schema Validation:** `zod`

## Troubleshooting

* **QR Code:** Use `get_session` for `qr_url`, or check logs / quickchart.io link.
* **Logged Out:** That session is marked `logged_out` (process keeps running). `delete_session` and create a new one, or remove `auth_info/<session_id>/` and recreate.
* **Full reset:** Stop the server, delete `./auth_info/` and `./data/`, restart.
* **MCP client issues:** Confirm `bun` is on `PATH` and the config path/`cwd` are absolute and correct.
* **Sending fails:** Ensure the session status is `connected` and the JID is valid.

## Credits

- https://github.com/lharries/whatsapp-mcp — similar idea in Go/Python.

## License

ISC (see `package.json`).
