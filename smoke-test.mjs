#!/usr/bin/env node
"use strict";

/**
 * Smoke test for the ignis-mcp plugin: boots a real Ignis server on a temp
 * vault, enables the plugin, and drives the MCP endpoint through real HTTP
 * (initialize -> tools/list -> write/read/search/move/delete).
 *
 * Run from the ignis repo root:  node apps/ignis-server/server/plugins/ignis-mcp/smoke-test.mjs
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 18432;
const BASE = `http://127.0.0.1:${PORT}`;

const work = mkdtempSync(path.join(tmpdir(), "ignis-mcp-test-"));
const vaults = path.join(work, "vaults");
const data = path.join(work, "data");

try {
  mkdirSync(vaults);
  mkdirSync(data);
  const vaultName = "TestVault";
  mkdirSync(path.join(vaults, vaultName));
  writeFileSync(
    path.join(vaults, vaultName, "existing.md"),
    "# Existing\nhello world from existing note\n",
  );

  // A second vault the plugin is NOT enabled for.
  mkdirSync(path.join(vaults, "OtherVault"));
  writeFileSync(path.join(vaults, "OtherVault", "x.md"), "x");

  writeFileSync(
    path.join(data, "plugin-config.json"),
    JSON.stringify({ "ignis-mcp": { enabledVaults: [vaultName] } }),
  );

  const env = {
    ...process.env,
    VAULT_ROOT: vaults,
    DATA_ROOT: data,
    PORT: String(PORT),
    IGNIS_MCP_TOKEN: "test-token-123",
  };

  const server = spawn(process.execPath, ["apps/ignis-server/server/index.js"], {
    cwd: path.resolve("."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs = [];
  server.stdout.on("data", (d) => logs.push(d.toString()));
  server.stderr.on("data", (d) => logs.push(d.toString()));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitForServer(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${BASE}/api/version`);
        if (res.ok) return;
      } catch {}
      await sleep(400);
    }
    throw new Error(`server did not start:\n${logs.join("")}`);
  }

  async function rpc(method, params, token = "test-token-123") {
    const res = await fetch(`${BASE}/api/ext/ignis-mcp/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method, params }),
    });
    return { status: res.status, body: await res.json() };
  }

  async function callTool(name, args) {
    const { body } = await rpc("tools/call", { name, arguments: args });
    if (body.error) throw new Error(`tools/call ${name} rpc error: ${JSON.stringify(body.error)}`);
    const text = body.result?.content?.[0]?.text ?? "";
    return { isError: body.result?.isError === true, text, json: safeJson(text) };
  }

  function safeJson(t) {
    try { return JSON.parse(t); } catch { return null; }
  }

  let failures = 0;
  function check(label, cond, detail = "") {
    if (cond) {
      console.log(`  ok: ${label}`);
    } else {
      failures++;
      console.error(`  FAIL: ${label} ${detail}`);
    }
  }

  await waitForServer();
  console.log("server up");

  // --- auth ---
  const noAuth = await rpc("tools/list", {}, "");
  check("401 without token", noAuth.status === 401, `got ${noAuth.status}`);

  const statusRes = await fetch(`${BASE}/api/ext/ignis-mcp/status`, {
    headers: { Authorization: "Bearer test-token-123" },
  });
  const status = await statusRes.json();
  check("status endpoint", statusRes.ok && status.ok && status.vaults.some((v) => v.id === vaultName && v.mcpEnabled));

  // --- initialize ---
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  check("initialize", init.body.result?.serverInfo?.name === "Ignis MCP");

  // --- tools/list ---
  const tools = await rpc("tools/list", {});
  const toolNames = (tools.body.result?.tools || []).map((t) => t.name);
  check("tools/list has 11 tools", toolNames.length === 11 && toolNames.includes("upload_file"), `got: ${toolNames.join(",")}`);

  // --- list_vaults ---
  const vaultsRes = await callTool("list_vaults", {});
  check("list_vaults", vaultsRes.json?.vaults?.some((v) => v.id === vaultName && v.mcpEnabled));

  // --- write_note ---
  const write = await callTool("write_note", { vault: vaultName, path: "AI/new-note.md", content: "# Agent Note\ncreated by ignis-mcp smoke test\nneedle-alpha-42\n" });
  check("write_note", write.json?.ok === true && write.json.path === "AI/new-note.md", write.text);

  // --- read_note ---
  const read = await callTool("read_note", { vault: vaultName, path: "AI/new-note.md" });
  check("read_note roundtrip", read.text.includes("needle-alpha-42"));

  const readExisting = await callTool("read_note", { vault: vaultName, path: "existing.md" });
  check("read existing note", readExisting.text.includes("hello world"));

  // --- append_note ---
  const append = await callTool("append_note", { vault: vaultName, path: "AI/new-note.md", content: "appended-line-xyz\n" });
  const read2 = await callTool("read_note", { vault: vaultName, path: "AI/new-note.md" });
  check("append_note", append.json?.ok && read2.text.includes("appended-line-xyz"));

  // --- upload_file (binary roundtrip) ---
  // Deterministic payload with bytes that are NOT valid utf-8 (0x80-0xff range).
  const binPayload = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG magic
    Buffer.alloc(1024, 0).map((_, i) => i % 256),
  ]);
  const binB64 = binPayload.toString("base64");
  const up = await callTool("upload_file", { vault: vaultName, path: "AI/assets/diagram.png", content_base64: binB64 });
  check("upload_file", up.json?.ok === true && up.json.path === "AI/assets/diagram.png" && up.json.bytes === binPayload.length, up.text);

  const readBinB64 = await callTool("read_note", { vault: vaultName, path: "AI/assets/diagram.png", base64: true });
  check("read_note base64 roundtrip", readBinB64.text === binB64);

  // base64 mode on a text file: decode must equal the plain-text read.
  const readMdB64 = await callTool("read_note", { vault: vaultName, path: "AI/new-note.md", base64: true });
  check("read_note base64 of text file", Buffer.from(readMdB64.text, "base64").toString("utf-8") === read2.text);

  // whitespace in base64 is tolerated (some clients wrap lines)
  const wrappedB64 = binB64.replace(/(.{76})/g, "$1\n");
  const upWrapped = await callTool("upload_file", { vault: vaultName, path: "AI/assets/diagram-wrapped.png", content_base64: wrappedB64 });
  check("upload_file tolerates wrapped base64", upWrapped.json?.ok === true, upWrapped.text);

  // invalid base64 rejected
  const badB64 = await callTool("upload_file", { vault: vaultName, path: "AI/bad.png", content_base64: "definitely!not*base64" });
  check("upload_file rejects invalid base64", badB64.isError === true && /base64/i.test(badB64.text), badB64.text);

  // oversize rejected (9MB decoded > 8MB cap) without writing the file
  const bigB64 = Buffer.alloc(9 * 1024 * 1024, 0xab).toString("base64");
  const tooBig = await callTool("upload_file", { vault: vaultName, path: "AI/too-big.bin", content_base64: bigB64 });
  check("upload_file rejects oversize", tooBig.isError === true && /TOO_LARGE/.test(tooBig.text), tooBig.text.slice(0, 120));
  const tooBigInfo = await callTool("get_note_info", { vault: vaultName, path: "AI/too-big.bin" });
  check("oversize upload wrote nothing", tooBigInfo.isError === true);

  // --- get_file_tree ---
  const tree = await callTool("get_file_tree", { vault: vaultName });
  check("get_file_tree", tree.json?.files?.includes("AI/new-note.md") && tree.json.files.includes("existing.md"));

  // --- search_notes ---
  const search = await callTool("search_notes", { vault: vaultName, query: "needle-alpha" });
  check("search_notes finds match", search.json?.matchCount === 1 && search.json.matches?.[0]?.path === "AI/new-note.md", search.text);

  // --- get_note_info ---
  const info = await callTool("get_note_info", { vault: vaultName, path: "AI/new-note.md" });
  check("get_note_info", info.json?.type === "file" && info.json.size > 0);

  // --- get_note_url ---
  const url = await callTool("get_note_url", { vault: vaultName, path: "AI/new-note.md" });
  check("get_note_url", url.json?.url?.includes(`vault=${encodeURIComponent(vaultName)}`) && url.json.url.includes("file=AI%2Fnew-note.md"));

  // --- move_path ---
  const move = await callTool("move_path", { vault: vaultName, oldPath: "AI/new-note.md", newPath: "AI/renamed.md" });
  const readMoved = await callTool("read_note", { vault: vaultName, path: "AI/renamed.md" });
  check("move_path", move.json?.ok && readMoved.text.includes("needle-alpha-42"));

  // --- delete_note (trash default) ---
  const del = await callTool("delete_note", { vault: vaultName, path: "AI/renamed.md" });
  check("delete_note to trash", del.json?.ok && del.json.trashedAs?.startsWith(".trash/"), del.text);
  const readGone = await callTool("read_note", { vault: vaultName, path: "AI/renamed.md" });
  check("deleted file unreadable", readGone.isError === true);

  // --- traversal guard ---
  const traversal = await callTool("read_note", { vault: vaultName, path: "../outside.md" });
  check("path traversal rejected", traversal.isError === true);

  // --- vault guards ---
  const disabled = await callTool("read_note", { vault: "OtherVault", path: "x.md" });
  check("disabled vault rejected", disabled.isError === true && /not enabled/i.test(disabled.text), disabled.text);
  const unknown = await callTool("read_note", { vault: "NoSuchVault", path: "x.md" });
  check("unknown vault rejected", unknown.isError === true && /not found/i.test(unknown.text), unknown.text);

  // --- GET on /mcp ---
  const getMcp = await fetch(`${BASE}/api/ext/ignis-mcp/mcp`);
  check("GET /mcp is 405", getMcp.status === 405);

  server.kill("SIGTERM");
  await sleep(300);

  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
