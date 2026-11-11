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

- **docs** — grounded documentation + hybrid search over the project's
  `README.md`, `docs/**/*.md`, `packages/<name>/README.md` and
  `CORRECTIONS.md`, and `_bmad-output/planning-artifacts/**/*.md`; nothing
  else is indexed, so files the app's users upload (`storage/`, `tmp/`, …)
  never reach the agent as documentation
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

## Embeddings are opt-in

Search is BM25 by default; nothing is downloaded and no model is loaded. To add
vector search, fetch the model once, on purpose:

```bash
npx ream-mcp-reindex --download-model
```

It prints what it fetches and from where (BAAI bge-small-en-v1.5 as ONNX,
about 134 MB, from `huggingface.co` at a pinned revision), checks every file
against the SHA-256 pinned in the native core, and deletes anything that does
not match. Then launch the server with:

| Launch env | Meaning |
|---|---|
| `REAM_MCP_EMBEDDINGS=1` | load the downloaded model (checked again on every load) |
| `ORT_DYLIB_PATH=/abs/path/libonnxruntime.so` | the ONNX Runtime library to load; required, never looked up on the library search path |
| `REAM_MCP_DISABLE_EMBEDDINGS=1` | force embeddings off, whatever else is set |

The server itself never fetches anything: a missing or altered model leaves
search on BM25 and says why in `knownGaps`.

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

## Errors

Following the MCP specification, an unknown tool name is a JSON-RPC error
(`-32602`), while a tool that runs and fails — including every structured
refusal (`{ error, hint }`) — returns a result with `isError: true`. A failure
message carries no stack trace and no absolute path; the full detail goes to
the server's stderr.
