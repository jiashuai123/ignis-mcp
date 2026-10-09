"use strict";

const fs = require("fs");
const path = require("path");
const {
  resolveVaultPath,
  toVaultRel,
  writeCoalescer,
  watcher,
} = require("@ignis/server-core");
const bootstrapCache = require("../../cache");

const {
  writeCoalesced,
  getPending,
  flushPending,
  flushPendingSubtree,
  supersedePending,
  supersedePendingSubtree,
} = writeCoalescer;

const TRASH_DIR = ".trash";
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024; // skip files larger than 2MB
const SNIPPET_RADIUS = 120;

// ---------------------------------------------------------------------------
// Vault resolution
// ---------------------------------------------------------------------------

function vaultError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function listVaults(ctx) {
  ctx.config.refreshVaults();
  const enabled = ctx.getEnabledVaults();

  return Object.entries(ctx.config.vaults).map(([id, vaultPath]) => ({
    id,
    name: id,
    path: vaultPath,
    mcpEnabled: enabled.includes(id),
  }));
}

function resolveVault(ctx, vaultId) {
  const id = vaultId || ctx.config.defaultVaultId;
  const vaultPath = ctx.config.getVaultPath(id);

  if (!vaultPath) {
    throw vaultError("VAULT_NOT_FOUND", `Vault not found: ${id}`);
  }

  if (!ctx.getEnabledVaults().includes(id)) {
    throw vaultError(
      "VAULT_NOT_ENABLED",
      `ignis-mcp is not enabled for vault "${id}". Enable it for that vault first (Ignis settings) or pass the id of an enabled vault.`,
    );
  }

  return { id, path: vaultPath };
}

// Mirror of the applyToTree helper in routes/fs.js: keep the bootstrap
// metadata tree in sync with plugin-caused mutations.
function applyTree(ctx, vaultId, events) {
  const batch = []
    .concat(events)
    .filter(
      (event) =>
        !watcher.isIgnoredPath(event.path) &&
        !(event.toPath && watcher.isIgnoredPath(event.toPath)),
    );

  if (batch.length === 0) {
    return;
  }

  bootstrapCache
    .applyMutation(vaultId, batch)
    .catch((e) =>
      console.warn(
        `[ignis-mcp] tree apply failed on vault ${vaultId}: ${e.message}`,
      ),
    );
}

function guardPath(ctx, vault, relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw vaultError("BAD_PATH", "path must be a non-empty string");
  }

  const resolved = resolveVaultPath(vault.path, relPath);

  if (!resolved) {
    throw vaultError("BAD_PATH", `Path rejected (traversal or invalid): ${relPath}`);
  }

  return resolved;
}

function rel(vault, resolved) {
  return toVaultRel(path.relative(vault.path, resolved));
}

// ---------------------------------------------------------------------------
// Tool handlers. Each returns { text } — text goes to the LLM as tool output.
// ---------------------------------------------------------------------------

async function readNote(ctx, args) {
  const vault = resolveVault(ctx, args.vault);
  const resolved = guardPath(ctx, vault, args.path);

  const stat = await fs.promises.stat(resolved).catch(() => null);

  if (!stat) {
    throw vaultError("ENOENT", `No such file: ${args.path}`);
  }

  if (stat.isDirectory()) {
    throw vaultError("EISDIR", `Path is a directory: ${args.path}`);
  }

  // Serve buffered content if a coalesced write is still pending.
  const buffered = getPending(resolved);

  const content =
    buffered !== null
      ? buffered.data.toString("utf-8")
      : await fs.promises.readFile(resolved, "utf-8");

  return { text: content };
}

async function writeNote(ctx, args) {
  if (typeof args.content !== "string") {
    throw vaultError("BAD_ARGS", "content must be a string");
  }

  const vault = resolveVault(ctx, args.vault);
  const resolved = guardPath(ctx, vault, args.path);

  await fs.promises.mkdir(path.dirname(resolved), { recursive: true });

  const result = await writeCoalesced(resolved, args.content, "utf-8");
  const r = rel(vault, resolved);

  applyTree(ctx, vault.id, { type: "modified", path: r });

  return {
    text: JSON.stringify(
      { ok: true, vault: vault.id, path: r, size: result.size, mtime: result.mtime },
      null,
      2,
    ),
  };
}

async function appendNote(ctx, args) {
  if (typeof args.content !== "string") {
    throw vaultError("BAD_ARGS", "content must be a string");
  }

  const vault = resolveVault(ctx, args.vault);
  const resolved = guardPath(ctx, vault, args.path);

  await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
  await flushPending(resolved);
  await fs.promises.appendFile(resolved, args.content, "utf-8");

  const r = rel(vault, resolved);
  applyTree(ctx, vault.id, { type: "modified", path: r });

  return {
    text: JSON.stringify({ ok: true, vault: vault.id, path: r }, null, 2),
  };
}

async function movePath(ctx, args) {
  const vault = resolveVault(ctx, args.vault);
  const oldResolved = guardPath(ctx, vault, args.oldPath);
  const newResolved = guardPath(ctx, vault, args.newPath);

  await flushPendingSubtree(oldResolved);
  await supersedePending(newResolved, () =>
    fs.promises.rename(oldResolved, newResolved),
  );

  const from = rel(vault, oldResolved);
  const to = rel(vault, newResolved);

  applyTree(ctx, vault.id, { type: "rename", path: from, toPath: to });

  return {
    text: JSON.stringify({ ok: true, vault: vault.id, from, to }, null, 2),
  };
}

async function deleteNote(ctx, args) {
  const vault = resolveVault(ctx, args.vault);
  const resolved = guardPath(ctx, vault, args.path);
  const toTrash = args.to_trash !== false; // default: trash, safer for agents
  const recursive = args.recursive === true;
  const r = rel(vault, resolved);

  if (toTrash) {
    const stat = await fs.promises.stat(resolved).catch(() => null);

    if (!stat) {
      throw vaultError("ENOENT", `No such path: ${args.path}`);
    }

    const trashRoot = resolveVaultPath(vault.path, TRASH_DIR);
    await fs.promises.mkdir(trashRoot, { recursive: true });

    // Timestamped name avoids clobbering previous trashed entries.
    const base = path.basename(resolved);
    const stamped = `${base}.${Date.now()}`;
    const trashTarget = path.join(trashRoot, stamped);

    await flushPendingSubtree(resolved);
    await supersedePending(trashTarget, () =>
      fs.promises.rename(resolved, trashTarget),
    );

    applyTree(ctx, vault.id, { type: "deleted", path: r });

    return {
      text: JSON.stringify(
        { ok: true, vault: vault.id, path: r, trashedAs: `${TRASH_DIR}/${stamped}` },
        null,
        2,
      ),
    };
  }

  const remove = () =>
    fs.promises.rm(resolved, { recursive }).catch((e) => {
      if (e.code !== "ENOENT") {
        throw e;
      }
    });

  if (recursive) {
    await supersedePendingSubtree(resolved, remove);
  } else {
    await supersedePending(resolved, remove);
  }

  applyTree(ctx, vault.id, { type: "deleted", path: r });

  return {
    text: JSON.stringify(
      { ok: true, vault: vault.id, path: r, trashed: false },
      null,
      2,
    ),
  };
}

async function getNoteInfo(ctx, args) {
  const vault = resolveVault(ctx, args.vault);
  const resolved = guardPath(ctx, vault, args.path);

  const stat = await fs.promises.stat(resolved).catch(() => null);

  if (!stat) {
    throw vaultError("ENOENT", `No such path: ${args.path}`);
  }

  const pending = getPending(resolved);
  const r = rel(vault, resolved);

  return {
    text: JSON.stringify(
      {
        vault: vault.id,
        path: r,
        type: stat.isDirectory() ? "directory" : "file",
        size: pending ? pending.data.length : stat.size,
        mtime: stat.mtimeMs,
        ctime: stat.birthtimeMs,
        hasPendingWrite: pending !== null,
      },
      null,
      2,
    ),
  };
}

async function getFileTree(ctx, args) {
  const vault = resolveVault(ctx, args.vault);
  const entry = await bootstrapCache.getOrBuild(vault.id);
  const tree = entry.response.tree;
  const extension = args.extension || null;
  const extFilter = extension
    ? (p) => p.toLowerCase().endsWith(extension.toLowerCase())
    : () => true;

  const files = [];
  const dirs = [];

  for (const [p, node] of Object.entries(tree)) {
    if (node.type === "directory") {
      dirs.push(p);
    } else if (extFilter(p)) {
      files.push(p);
    }
  }

  return {
    text: JSON.stringify(
      {
        vault: vault.id,
        etag: entry.etag,
        fileCount: files.length,
        dirCount: dirs.length,
        files,
        dirs,
      },
      null,
      2,
    ),
  };
}

async function searchNotes(ctx, args) {
  if (typeof args.query !== "string" || args.query.length === 0) {
    throw vaultError("BAD_ARGS", "query must be a non-empty string");
  }

  const vault = resolveVault(ctx, args.vault);
  const limit = Math.min(
    Math.max(1, args.limit || DEFAULT_SEARCH_LIMIT),
    MAX_SEARCH_LIMIT,
  );
  const extension = args.extension || ".md";
  const caseSensitive = args.case_sensitive === true;
  const useRegex = args.regex === true;

  let matcher;

  if (useRegex) {
    let re;

    try {
      re = new RegExp(args.query, caseSensitive ? "" : "i");
    } catch (e) {
      throw vaultError("BAD_REGEX", `Invalid regex: ${e.message}`);
    }

    matcher = (line) => re.test(line);
  } else {
    const needle = caseSensitive ? args.query : args.query.toLowerCase();
    matcher = (line) =>
      (caseSensitive ? line : line.toLowerCase()).includes(needle);
  }

  const entry = await bootstrapCache.getOrBuild(vault.id);
  const tree = entry.response.tree;
  const matches = [];

  const candidates = Object.entries(tree)
    .filter(
      ([p, node]) =>
        node.type === "file" &&
        p.toLowerCase().endsWith(extension.toLowerCase()) &&
        !p.startsWith(".obsidian/") &&
        !p.startsWith(`${TRASH_DIR}/`) &&
        !watcher.isIgnoredPath(p),
    )
    .sort(([a], [b]) => a.localeCompare(b));

  for (const [p, node] of candidates) {
    if (matches.length >= limit) {
      break;
    }

    if (node.size && node.size > MAX_SEARCH_FILE_BYTES) {
      continue; // skip very large files
    }

    const vaultPath = resolveVaultPath(vault.path, p);

    if (!vaultPath) {
      continue;
    }

    const content = await fs.promises.readFile(vaultPath, "utf-8").catch(() => null);

    if (content === null) {
      continue;
    }

    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= limit) {
        break;
      }

      if (matcher(lines[i])) {
        const line = lines[i];
        const col = line.indexOf(args.query);
        const start = Math.max(0, (col < 0 ? 0 : col) - SNIPPET_RADIUS);
        const end = Math.min(line.length, start + SNIPPET_RADIUS * 2);

        matches.push({
          path: p,
          line: i + 1,
          snippet: line.slice(start, end).trim(),
        });
      }
    }
  }

  return {
    text: JSON.stringify(
      {
        vault: vault.id,
        query: args.query,
        scannedFiles: candidates.length,
        matchCount: matches.length,
        truncated: matches.length >= limit,
        matches,
      },
      null,
      2,
    ),
  };
}

function getNoteUrl(ctx, args, extras) {
  const vault = resolveVault(ctx, args.vault);
  guardPath(ctx, vault, args.path);

  const base = (extras && extras.baseUrl) || "";
  const url = `${base}/?vault=${encodeURIComponent(vault.id)}&file=${encodeURIComponent(args.path)}`;

  return { text: JSON.stringify({ url }, null, 2) };
}

function listVaultsTool(ctx) {
  return {
    text: JSON.stringify(
      { vaults: listVaults(ctx), defaultVault: ctx.config.defaultVaultId },
      null,
      2,
    ),
  };
}

// ---------------------------------------------------------------------------
// Tool definitions (JSON Schema for MCP tools/list)
// ---------------------------------------------------------------------------

const vaultParam = {
  type: "string",
  description:
    "Vault id. Omit to use the default vault. The plugin must be enabled for the vault.",
};

const pathParam = {
  type: "string",
  description: "Vault-relative path, e.g. 'Notes/idea.md'. Forward slashes.",
};

const TOOLS = [
  {
    name: "list_vaults",
    description:
      "List all vaults on this Ignis server and whether ignis-mcp is enabled for each.",
    inputSchema: { type: "object", properties: {} },
    handler: (ctx) => listVaultsTool(ctx),
  },
  {
    name: "get_file_tree",
    description:
      "Get the vault's file tree (paths only, with etag). Optionally filter by extension.",
    inputSchema: {
      type: "object",
      properties: {
        vault: vaultParam,
        extension: {
          type: "string",
          description: "Only include files ending with this suffix, e.g. '.md'.",
        },
      },
    },
    handler: (ctx, args) => getFileTree(ctx, args),
  },
  {
    name: "read_note",
    description:
      "Read a text file (typically markdown) from the vault. Returns the raw file content.",
    inputSchema: {
      type: "object",
      properties: { vault: vaultParam, path: pathParam },
      required: ["path"],
    },
    handler: (ctx, args) => readNote(ctx, args),
  },
  {
    name: "write_note",
    description:
      "Write (create or overwrite) a text file in the vault. Parent directories are created automatically. Browser tabs see the change within ~1 second.",
    inputSchema: {
      type: "object",
      properties: {
        vault: vaultParam,
        path: pathParam,
        content: { type: "string", description: "Full file content (utf-8)." },
      },
      required: ["path", "content"],
    },
    handler: (ctx, args) => writeNote(ctx, args),
  },
  {
    name: "append_note",
    description: "Append text to the end of a file in the vault (creates it if missing).",
    inputSchema: {
      type: "object",
      properties: {
        vault: vaultParam,
        path: pathParam,
        content: { type: "string", description: "Text to append." },
      },
      required: ["path", "content"],
    },
    handler: (ctx, args) => appendNote(ctx, args),
  },
  {
    name: "move_path",
    description:
      "Move or rename a file or directory within the vault. Works for restructuring notes.",
    inputSchema: {
      type: "object",
      properties: {
        vault: vaultParam,
        oldPath: pathParam,
        newPath: {
          type: "string",
          description: "New vault-relative path.",
        },
      },
      required: ["oldPath", "newPath"],
    },
    handler: (ctx, args) => movePath(ctx, args),
  },
  {
    name: "delete_note",
    description:
      "Delete a file or directory. By default moves it to the vault's .trash/ folder (Obsidian convention); set to_trash=false for a permanent delete (recursive=true for directories).",
    inputSchema: {
      type: "object",
      properties: {
        vault: vaultParam,
        path: pathParam,
        to_trash: {
          type: "boolean",
          description: "Move to .trash/ instead of deleting (default true).",
        },
        recursive: {
          type: "boolean",
          description: "Required true when permanently deleting a non-empty directory.",
        },
      },
      required: ["path"],
    },
    handler: (ctx, args) => deleteNote(ctx, args),
  },
  {
    name: "get_note_info",
    description: "Get stat info (size, mtime, type) for a path in the vault.",
    inputSchema: {
      type: "object",
      properties: { vault: vaultParam, path: pathParam },
      required: ["path"],
    },
    handler: (ctx, args) => getNoteInfo(ctx, args),
  },
  {
    name: "search_notes",
    description:
      "Full-text search across the vault's notes (server-side). Substring by default, or regex. Returns path + line number + snippet per match.",
    inputSchema: {
      type: "object",
      properties: {
        vault: vaultParam,
        query: { type: "string", description: "Search text or regex pattern." },
        regex: { type: "boolean", description: "Treat query as a regex (default false)." },
        case_sensitive: { type: "boolean", description: "Case-sensitive match (default false)." },
        extension: {
          type: "string",
          description: "File suffix to search (default '.md').",
        },
        limit: { type: "number", description: "Max matches to return (default 50, max 200)." },
      },
      required: ["query"],
    },
    handler: (ctx, args) => searchNotes(ctx, args),
  },
  {
    name: "get_note_url",
    description:
      "Get a browser URL that opens this note directly in Ignis (Obsidian in the browser). Useful for handing a human a link to what was just edited.",
    inputSchema: {
      type: "object",
      properties: { vault: vaultParam, path: pathParam },
      required: ["path"],
    },
    handler: (ctx, args, extras) => getNoteUrl(ctx, args, extras),
  },
];

function listToolDefs() {
  return TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

async function callTool(name, args, ctx, extras) {
  const tool = TOOLS.find((t) => t.name === name);

  if (!tool) {
    throw vaultError("UNKNOWN_TOOL", `Unknown tool: ${name}`);
  }

  const result = await tool.handler(ctx, args || {}, extras);
  return result || { text: "" };
}

module.exports = {
  PROTOCOL_VERSION: "2025-06-18",
  listToolDefs,
  callTool,
  listVaults,
};
