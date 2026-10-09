"use strict";

/**
 * ignis-mcp — Ignis server plugin exposing an MCP (Model Context Protocol)
 * endpoint at /api/ext/ignis-mcp/mcp so AI agents can operate vault documents.
 *
 * Zero external dependencies: the MCP streamable-HTTP surface is implemented
 * with a minimal JSON-RPC 2.0 dispatcher in mcp.js. File operations reuse the
 * same server-core primitives as the built-in /api/fs routes (path guards,
 * write coalescer, bootstrap tree cache), so writes are serialized per path,
 * the metadata tree stays consistent, and browser tabs see changes within ~1s.
 */

const PROTOCOL_VERSION = "2025-06-18";

module.exports = {
  id: "ignis-mcp",
  name: "Ignis MCP",
  description:
    "MCP endpoint for AI agents to read, write, organize, and search vault documents",
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,

  _ctx: null,
  _onVaultChange: null,

  async register(ctx) {
    this._ctx = ctx;

    const enabled = ctx.getEnabledVaults();
    ctx.log(`registered (protocol ${PROTOCOL_VERSION}, vaults: ${enabled.join(", ") || "none"})`);

    // Broadcast vault change events on the plugin channel so browser-side
    // companions or dashboards can observe agent activity.
    try {
      this._channel = ctx.wss.channel("plugin:ignis-mcp");
      this._onVaultChange = (vaultId, event) => {
        if (this._channel && enabled.includes(vaultId)) {
          this._channel.broadcastToVault(vaultId, {
            type: "vault-change",
            payload: { vaultId, event },
          });
        }
      };
      ctx.watcher.addGlobalListener(this._onVaultChange);
    } catch (e) {
      ctx.log(`watcher broadcast not available: ${e.message}`);
    }

    const { mountRoutes } = require("./routes");
    mountRoutes(ctx.router, this);
  },

  getCtx() {
    return this._ctx;
  },

  async shutdown() {
    if (this._ctx && this._onVaultChange) {
      try {
        this._ctx.watcher.removeGlobalListener(this._onVaultChange);
      } catch {
        // watcher already torn down
      }
    }
    this._onVaultChange = null;
    this._channel = null;
    this._ctx = null;
  },

  async onVaultEnabled(vaultId) {
    if (this._ctx) {
      this._ctx.log(`vault enabled: ${vaultId}`);
    }
  },

  async onVaultDisabled(vaultId) {
    if (this._ctx) {
      this._ctx.log(`vault disabled: ${vaultId}`);
    }
  },
};
