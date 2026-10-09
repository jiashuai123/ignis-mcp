# ignis-mcp

English | [简体中文](README.zh-CN.md)

An [Ignis](https://github.com/Nystik-gh/ignis) server plugin that exposes an
**MCP (Model Context Protocol) endpoint** so AI agents can operate vault
documents: read, write, append, move, delete, list, and full-text search —
plus hand a human a URL that opens the note in the browser.

Zero external dependencies. File operations reuse the same server-core
primitives as the built-in `/api/fs` routes (path traversal guard, write
coalescer, bootstrap tree cache), so:

- writes to the same path are serialized and never lost,
- the vault metadata tree stays consistent,
- open browser tabs see agent edits within ~1 second.

## Install

Drop this folder into `apps/ignis-server/server/plugins/ignis-mcp/` of your
Ignis checkout and restart the server (for Docker, mount the folder into the
container at the same path or rebuild the image).

```yaml
# docker-compose.yml addition
volumes:
  - ./ignis-mcp:/app/apps/ignis-server/server/plugins/ignis-mcp
```

Then enable the plugin for a vault (Ignis settings → plugins, per vault), or
enable it in `data/plugin-config.json`:

```json
{ "ignis-mcp": { "enabledVaults": ["My Vault"] } }
```

Tools only operate on vaults the plugin is enabled for.

## MCP endpoint

```
POST /api/ext/ignis-mcp/mcp        # streamable HTTP (JSON responses)
GET  /api/ext/ignis-mcp/status     # health / auth / vault overview
```

Protocol: MCP `2025-06-18` over JSON-RPC 2.0. Stateless JSON mode (no SSE).
Any remote-MCP client can connect with the URL; stdio-only clients use the
bundled bridge:

```json
{
  "mcpServers": {
    "ignis": {
      "command": "node",
      "args": ["/path/to/ignis-mcp/bin/ignis-mcp-stdio.js"],
      "env": {
        "IGNIS_MCP_URL": "https://notes.example.com",
        "IGNIS_MCP_TOKEN": "your-token"
      }
    }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `list_vaults` | All vaults + whether ignis-mcp is enabled for each |
| `get_file_tree` | Vault file tree with etag, optional extension filter |
| `read_note` | Read a file (returns raw content) |
| `write_note` | Create/overwrite a file; parent dirs auto-created |
| `append_note` | Append text to a file |
| `move_path` | Move/rename a file or directory |
| `delete_note` | Delete; **defaults to `.trash/`** (Obsidian convention), `to_trash=false` for permanent |
| `get_note_info` | stat (size, mtime, type) |
| `search_notes` | Server-side full-text search (substring or regex), path+line+snippet |
| `get_note_url` | Browser URL that opens the note directly (`?vault=&file=`) |

## Auth

Ignis has no built-in authentication — put the server behind a reverse proxy
with HTTPS + auth before exposing it. For the MCP endpoint specifically, you
can also set a bearer token:

```bash
# option 1: environment variable (always wins)
IGNIS_MCP_TOKEN=change-me

# option 2: HTTP route (file-based, stored in the plugin dataDir)
curl -X POST https://host/api/ext/ignis-mcp/token \
  -H 'Content-Type: application/json' \
  -d '{"token":"change-me"}'
```

Clients send `Authorization: Bearer <token>`.

Optional env:

- `IGNIS_MCP_PUBLIC_URL` — base URL used by `get_note_url` when the server is
  behind a proxy and the request host differs from the public one.

## Security notes

- All paths are vault-relative and pass the same lexical + symlink traversal
  guards as the built-in API; writes go through the write coalescer.
- `delete_note` is trash-by-default so an agent mistake is recoverable.
- Vault scope: tools are restricted to vaults where the plugin is enabled.
- If a token is set, `/mcp` requires it; without a token the endpoint relies
  on whatever auth fronts the whole Ignis server.
