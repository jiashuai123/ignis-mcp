#!/usr/bin/env node
"use strict";

/**
 * ignis-mcp stdio bridge — connects a stdio MCP client (Claude Desktop,
 * CodeBuddy, Cursor, ...) to an ignis-mcp streamable HTTP endpoint.
 *
 * Zero dependencies (Node 18+ for global fetch).
 *
 * Usage:
 *   node ignis-mcp-stdio.js
 *
 * Environment:
 *   IGNIS_MCP_URL    Base URL of the Ignis server (default http://localhost:8080)
 *   IGNIS_MCP_TOKEN  Bearer token, if the endpoint has one set (default: none)
 *
 * Example client config (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "ignis": {
 *         "command": "node",
 *         "args": ["/path/to/ignis-mcp/bin/ignis-mcp-stdio.js"],
 *         "env": {
 *           "IGNIS_MCP_URL": "https://notes.example.com",
 *           "IGNIS_MCP_TOKEN": "your-token"
 *         }
 *       }
 *     }
 *   }
 */

const readline = require("readline");

const BASE_URL = (process.env.IGNIS_MCP_URL || "http://localhost:8080").replace(/\/+$/, "");
const ENDPOINT = `${BASE_URL}/api/ext/ignis-mcp/mcp`;
const TOKEN = process.env.IGNIS_MCP_TOKEN || "";

async function postRpc(message) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (TOKEN) {
    headers.Authorization = `Bearer ${TOKEN}`;
  }

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });

  if (res.status === 202) {
    return null; // notification acknowledged
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ignis-mcp endpoint ${res.status}: ${text.slice(0, 300)}`);
  }

  return res.json();
}

function writeMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  // Track in-flight upstream requests so stdin close doesn't kill them.
  let pending = 0;
  let closed = false;

  const maybeExit = () => {
    if (closed && pending === 0) {
      process.exit(0);
    }
  };

  rl.on("line", (line) => {
    const trimmed = line.trim();

    if (!trimmed) {
      return;
    }

    let message;

    try {
      message = JSON.parse(trimmed);
    } catch {
      writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    pending++;
    postRpc(message)
      .then((response) => {
        if (response !== null) {
          writeMessage(response);
        }
      })
      .catch((e) => {
        if (message.id !== undefined && message.id !== null) {
          writeMessage({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: e.message },
          });
        } else {
          process.stderr.write(`[ignis-mcp-stdio] ${e.message}\n`);
        }
      })
      .finally(() => {
        pending--;
        maybeExit();
      });
  });

  rl.on("close", () => {
    closed = true;
    maybeExit();
  });
}

main().catch((e) => {
  process.stderr.write(`[ignis-mcp-stdio] fatal: ${e.message}\n`);
  process.exit(1);
});
