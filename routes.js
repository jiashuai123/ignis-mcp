"use strict";

const { sanitizeError } = require("@ignis/server-core");
const auth = require("./auth");
const { handleMessage } = require("./mcp");
const { listVaults } = require("./tools");

function mountRoutes(router, plugin) {
  const ctx = () => plugin.getCtx();

  function publicBaseUrl(req) {
    if (process.env.IGNIS_MCP_PUBLIC_URL) {
      return process.env.IGNIS_MCP_PUBLIC_URL.replace(/\/+$/, "");
    }

    return `${req.protocol}://${req.get("host")}`;
  }

  // GET /api/ext/ignis-mcp/status — quick health/auth check
  router.get("/status", (req, res) => {
    const c = ctx();

    if (!c) {
      return res.status(503).json({ error: "Plugin not registered" });
    }

    const token = auth.loadToken(c.dataDir);

    res.json({
      ok: true,
      plugin: "ignis-mcp",
      version: plugin.version,
      protocol: plugin.protocolVersion,
      endpoint: "/api/ext/ignis-mcp/mcp",
      auth: {
        required: Boolean(token),
        tokenSource: auth.usingEnvToken() ? "env" : token ? "file" : "none",
      },
      vaults: listVaults(c),
    });
  });

  // POST /api/ext/ignis-mcp/mcp — MCP streamable HTTP endpoint (JSON mode)
  router.post("/mcp", async (req, res) => {
    const c = ctx();

    if (!c) {
      return res.status(503).json({ error: "Plugin not registered" });
    }

    const token = auth.loadToken(c.dataDir);

    if (!auth.isAuthorized(req, token)) {
      res.set("WWW-Authenticate", 'Bearer realm="ignis-mcp"');
      return res.status(401).json({ error: "Unauthorized" });
    }

    const body = req.body;

    // Single request (MCP 2025-06-18 dropped JSON-RPC batching).
    if (Array.isArray(body)) {
      return res
        .status(400)
        .json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch requests are not supported" } });
    }

    try {
      const response = await handleMessage(body, plugin, {
        baseUrl: publicBaseUrl(req),
      });

      if (response === null) {
        // Notification: acknowledge with no body.
        return res.status(202).end();
      }

      return res.json(response);
    } catch (e) {
      return res
        .status(500)
        .json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32603, message: sanitizeError(e).error || "Internal error" } });
    }
  });

  // Streamable HTTP servers must reject GET on the MCP endpoint when they
  // don't offer an SSE stream.
  router.get("/mcp", (req, res) => {
    res.set("Allow", "POST");
    res.status(405).json({ error: "SSE streaming not supported; use POST with JSON" });
  });

  // Token management (only when the token is file-based, not env-pinned).
  router.post("/token", (req, res) => {
    const c = ctx();

    if (!c) {
      return res.status(503).json({ error: "Plugin not registered" });
    }

    if (auth.usingEnvToken()) {
      return res.status(409).json({ error: "Token is pinned by IGNIS_MCP_TOKEN env; manage it there" });
    }

    const current = auth.loadToken(c.dataDir);

    if (current && !auth.isAuthorized(req, current)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { token } = req.body || {};

    if (typeof token !== "string" || token.length < 8) {
      return res.status(400).json({ error: "token must be a string of at least 8 characters" });
    }

    try {
      auth.saveToken(c.dataDir, token);
      c.log("MCP token updated");
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json(sanitizeError(e));
    }
  });

  router.delete("/token", (req, res) => {
    const c = ctx();

    if (!c) {
      return res.status(503).json({ error: "Plugin not registered" });
    }

    if (auth.usingEnvToken()) {
      return res.status(409).json({ error: "Token is pinned by IGNIS_MCP_TOKEN env; manage it there" });
    }

    const current = auth.loadToken(c.dataDir);

    if (current && !auth.isAuthorized(req, current)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      auth.clearToken(c.dataDir);
      c.log("MCP token cleared");
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json(sanitizeError(e));
    }
  });
}

module.exports = { mountRoutes };
