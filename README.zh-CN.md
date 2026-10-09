# ignis-mcp（中文版）

[English](README.md) | 简体中文

一个 [Ignis](https://github.com/Nystik-gh/ignis) 服务端插件，暴露 **MCP（Model Context Protocol）端点**，
让 AI Agent 能操作 vault 文档：读取、写入、追加、移动、删除、列出文件、全文搜索——
还能生成一个直接在浏览器中打开该笔记的 URL，方便把 AI 的改动交给人工查看。

零外部依赖。文件操作复用与 Ignis 内置 `/api/fs` 路由相同的 server-core 原语
（路径穿越防护、写合并器、bootstrap 树缓存），因此：

- 同一路径的写入按序串行化，不会丢失；
- vault 元数据树保持一致；
- 已打开的浏览器标签页约 1 秒内就能看到 Agent 的改动。

## 安装

把本目录放到 Ignis 代码的 `apps/ignis-server/server/plugins/ignis-mcp/` 下并重启服务器
（Docker 部署则把目录挂载到容器内相同路径，或重新构建镜像）。

```yaml
# docker-compose.yml 追加
volumes:
  - ./ignis-mcp:/app/apps/ignis-server/server/plugins/ignis-mcp
```

然后在某个 vault 上启用插件（Ignis 设置 → 插件，按 vault 开启），
或直接修改 `data/plugin-config.json`：

```json
{ "ignis-mcp": { "enabledVaults": ["My Vault"] } }
```

工具只能操作已启用插件的 vault。

## MCP 端点

```
POST /api/ext/ignis-mcp/mcp        # streamable HTTP（JSON 响应）
GET  /api/ext/ignis-mcp/status     # 健康检查 / 鉴权状态 / vault 概览
```

协议：MCP `2025-06-18`，基于 JSON-RPC 2.0。无状态 JSON 模式（不走 SSE）。
支持远程 MCP 的客户端直接填 URL 即可；仅支持 stdio 的客户端使用内置桥接：

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

## 工具列表

| 工具 | 功能 |
|---|---|
| `list_vaults` | 列出所有 vault 及插件是否已对其启用 |
| `get_file_tree` | vault 文件树（带 etag），可按扩展名过滤 |
| `read_note` | 读取文件（返回原始内容） |
| `write_note` | 创建/覆盖文件；父目录自动创建 |
| `append_note` | 向文件末尾追加文本 |
| `move_path` | 移动/重命名文件或目录 |
| `delete_note` | 删除；**默认移入 `.trash/`**（Obsidian 惯例），`to_trash=false` 时永久删除 |
| `get_note_info` | 查看文件信息（大小、修改时间、类型） |
| `search_notes` | 服务端全文搜索（支持子串或正则），返回路径+行号+片段 |
| `get_note_url` | 生成可直接打开该笔记的浏览器 URL（`?vault=&file=`） |

## 鉴权

Ignis 本身没有内置鉴权——对外暴露前务必置于反向代理之后（HTTPS + 认证）。
针对 MCP 端点，还可以单独设置 Bearer Token：

```bash
# 方式一：环境变量（优先级最高）
IGNIS_MCP_TOKEN=change-me

# 方式二：HTTP 路由（存入插件 dataDir 的文件）
curl -X POST https://host/api/ext/ignis-mcp/token \
  -H 'Content-Type: application/json' \
  -d '{"token":"change-me"}'
```

客户端请求时携带 `Authorization: Bearer <token>`。

可选环境变量：

- `IGNIS_MCP_PUBLIC_URL` — 服务器在反向代理之后、请求 host 与公网地址不一致时，
  `get_note_url` 用它作为 URL 前缀。

## 安全说明

- 所有路径均为 vault 相对路径，通过与内置 API 相同的词法 + 符号链接穿越防护；
  写入经过写合并器。
- `delete_note` 默认进回收站，Agent 误删可恢复。
- vault 范围：工具仅限插件已启用的 vault。
- 设置 token 后 `/mcp` 必须携带；未设置 token 时，端点依赖整个 Ignis 服务前置的鉴权。
