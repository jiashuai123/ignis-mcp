"use strict";

const fs = require("fs");
const path = require("path");

const TOKEN_FILE = "mcp-token.json";

/**
 * Bearer-token auth for the MCP endpoint. Ignis itself has no built-in
 * authentication, so an MCP endpoint exposed through a reverse proxy should
 * either keep proxy-level auth or set a token here.
 *
 * Token sources (env wins):
 *   - IGNIS_MCP_TOKEN environment variable
 *   - <dataDir>/mcp-token.json  { "token": "..." }  (managed via HTTP routes)
 */

function tokenFilePath(dataDir) {
  return path.join(dataDir, TOKEN_FILE);
}

function loadToken(dataDir) {
  if (process.env.IGNIS_MCP_TOKEN) {
    return process.env.IGNIS_MCP_TOKEN;
  }

  try {
    const data = JSON.parse(fs.readFileSync(tokenFilePath(dataDir), "utf-8"));
    return data.token || null;
  } catch {
    return null;
  }
}

function saveToken(dataDir, token) {
  fs.writeFileSync(tokenFilePath(dataDir), JSON.stringify({ token }, null, 2));
}

function clearToken(dataDir) {
  try {
    fs.unlinkSync(tokenFilePath(dataDir));
  } catch {
    // already gone
  }
}

function usingEnvToken() {
  return Boolean(process.env.IGNIS_MCP_TOKEN);
}

function isAuthorized(req, token) {
  if (!token) {
    return true; // no token configured; rely on network/reverse-proxy auth
  }

  const header = req.headers.authorization || "";

  return header === `Bearer ${token}`;
}

module.exports = { loadToken, saveToken, clearToken, usingEnvToken, isAuthorized };
