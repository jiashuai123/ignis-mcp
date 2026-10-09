"use strict";

/**
 * Minimal MCP (Model Context Protocol) JSON-RPC 2.0 dispatcher for the
 * streamable HTTP transport. Stateless: every POST carries a full request,
 * and the server replies with a single application/json response (allowed by
 * the spec; no SSE stream needed for tools-only usage).
 */

const { listToolDefs, callTool } = require("./tools");

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function isNotification(message) {
  return message.id === undefined || message.id === null;
}

async function handleRequest(message, plugin, extras) {
  const ctx = plugin.getCtx();

  if (!ctx) {
    return rpcError(message.id, -32603, "Plugin is not registered");
  }

  switch (message.method) {
    case "initialize":
      return rpcResult(message.id, {
        protocolVersion: plugin.protocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: plugin.name,
          version: plugin.version,
        },
      });

    case "ping":
      return rpcResult(message.id, {});

    case "tools/list":
      return rpcResult(message.id, { tools: listToolDefs() });

    case "tools/call": {
      const { name, arguments: args } = message.params || {};

      try {
        const result = await callTool(name, args, ctx, extras);

        return rpcResult(message.id, {
          content: [{ type: "text", text: result.text }],
        });
      } catch (e) {
        // Tool errors are reported in-band (isError) per the MCP spec.
        return rpcResult(message.id, {
          content: [{ type: "text", text: `${e.code ? `${e.code}: ` : ""}${e.message}` }],
          isError: true,
        });
      }
    }

    case "resources/list":
      return rpcResult(message.id, { resources: [] });

    case "prompts/list":
      return rpcResult(message.id, { prompts: [] });

    default:
      return rpcError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

/**
 * Handle one JSON-RPC message. Returns the response object, or null for
 * notifications (no response expected).
 */
async function handleMessage(message, plugin, extras) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
    return rpcError(null, -32600, "Invalid Request");
  }

  if (typeof message.method !== "string") {
    return rpcError(message.id ?? null, -32600, "Invalid Request");
  }

  // Notifications (initialized, cancelled, ...) get no response.
  if (isNotification(message)) {
    return null;
  }

  return handleRequest(message, plugin, extras);
}

module.exports = { handleMessage };
