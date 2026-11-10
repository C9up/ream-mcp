# `@c9up/ream-mcp`

First-party Model Context Protocol (MCP) server for the Ream
framework. Turns a Ream project into an agent-ready workspace —
LLMs (Claude Code, Cursor, Zed, Codex) query grounded docs,
introspect the live project, scaffold code, and navigate BMAD
traceability through typed MCP tools, instead of reading
hundreds of files into context.

## Tools

The MCP stdio server (Rust core `ream-mcp-core` wired through NAPI) exposes a
full toolset over `tools/list` — call it for the authoritative, up-to-date
descriptors. The current categories:

- **docs** — grounded documentation + hybrid search over the Ream docs
- **introspect** — inspect routes, providers, decorated services
- **generate** — scaffold controllers, entities, providers, modules, …
- **migrations** — status / run / rollback helpers
- **security** — security-surface checks
- **doctor** — environment health checks
- **inker** — template-engine helpers
- **station** — admin-panel tooling
- **scheduler** — scheduled-task inspection
- **bmad** — BMAD workflow helpers

## Usage

Add the server to the project, then register it in the project's `.mcp.json`:

```bash
ream add -D @c9up/ream-mcp
ream mcp install                     # writes `npx --no @c9up/ream-mcp`
```

`--no` runs the version the project's lockfile pins and never downloads one.

The server auto-detects the Ream project root by walking up from
`cwd` and checking for, in order:

1. `reamrc.ts` (canonical config name)
2. `ream.config.ts` (legacy alias)
3. `package.json` containing `@c9up/ream` in deps

Set `REAM_PROJECT_ROOT=/path/to/project` to override.

## Migration writes are off by default

`migration.run` and `migration.rollback` preview by default. A real run
(`dryRun: false, confirm: true`) is refused unless the user enables it when
launching the server — no tool argument can, since the model calling the tool
writes every argument:

| Launch env | Allows |
|---|---|
| `REAM_MCP_ALLOW_MIGRATIONS=1` | writes to a local database: a sqlite file inside the project, or a loopback / unix-socket server |
| `REAM_MCP_ALLOW_PRODUCTION_MIGRATIONS=1` (with the above) | writes to production: `REAM_ENV`/`NODE_ENV` is `production`, or the database URL is anything not provably local |

Set them in the `env` block of the server's `.mcp.json` entry. A preview is not
side-effect free either: it imports each migration module and runs its `up()` /
`down()` in the server process to collect the SQL, so it executes project code.

## Architecture

Hybrid TypeScript + Rust + NAPI, mirroring the ream-events / Atom
pattern:

```
packages/ream-mcp/
├── src/                              TS server + utilities
├── crates/
│   ├── ream-mcp-core/                pure Rust business logic
│   └── ream-mcp-napi/                #[napi] thin bindings
└── scripts/copy-napi.mjs             cargo cdylib → .node copy
```

**Stdio MCP servers MUST NOT write to stdout** — that would
corrupt the JSON-RPC stream. All observability goes through
`stderr`. Future tools added to this server must inherit this
constraint.

## MCP SDK pin

Locked to `@modelcontextprotocol/sdk@^1.x`. v2.0 (alpha as of
2026-04) changes error semantics (`-32602` on unknown tools
instead of `isError: true`); we follow up post-Q1 2026.
