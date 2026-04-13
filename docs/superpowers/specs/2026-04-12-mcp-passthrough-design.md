# MCP Server Passthrough to Workflow Agents

## Problem

Workflow agents spawned via Claude Code SDK don't have access to MCP tools (Linear, Supabase, etc.) that the user has installed as Claude Code plugins. The agents run with `settingSources: ['project']`, which skips user-level plugin loading. This means workflows that need to update Linear issues, query databases, or use other MCP-backed services must fall back to manual instructions.

## Design

Discover MCP server configs from the user's installed Claude Code plugins and project-level `.mcp.json`, then pass them through to workflow agent sessions via the SDK's `mcpServers` option. Workflow YAML can filter which servers are available.

### Discovery

Two sources, different timing:

**User plugins (startup, cached on `WorkflowDeps.mcpServers`):**

Two plugin categories, discovered from `~/.claude/plugins/`:

1. **Installed plugins** — read `~/.claude/plugins/installed_plugins.json` (maps plugin names to `{ installPath, version, ... }`). For each entry, read `<installPath>/.mcp.json`. Format is wrapped: `{ "mcpServers": { "name": { "command": "...", "args": [...] } } }`. Example: context-mode at `~/.claude/plugins/cache/context-mode/context-mode/1.0.49/.mcp.json`.

2. **External plugins** — glob `~/.claude/plugins/marketplaces/*/external_plugins/*/.mcp.json`. Format is flat: `{ "name": { "type": "http", "url": "..." } }`. Example: Linear at `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/linear/.mcp.json`.

Cross-reference with `~/.claude/settings.json` → `enabledPlugins` to skip disabled plugins.

Additional rules:
- Handle both `.mcp.json` formats (flat and wrapped) — normalize to `Record<string, McpServerConfig>`
- Resolve env var references in `args` and other string fields from `process.env` at discovery time. Support both `${VAR}` (Claude Code plugin convention) and `$VAR_NAME` (Archon's existing `expandEnvVars` convention) for consistency. Regex: `/\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g`. Unresolvable vars → empty string + warning (auth error is better than silent drop)
- Preserve the `env` field on `McpServerConfig` as-is — it defines additional env vars for the spawned MCP server process, separate from env var resolution in string fields
- Graceful degradation: log warning + skip any plugin with missing/malformed `.mcp.json`
- Pin a comment in the discovery code noting the assumed `~/.claude/plugins/` directory structure — this is Claude Code's internal layout and may change between versions

New module: `packages/core/src/mcp/discovery.ts`
- `discoverUserMcpServers(): Record<string, McpServerConfig>` — scan installed + external plugins, cross-reference `enabledPlugins`, normalize both formats, resolve env vars
- `discoverProjectMcpServers(cwd: string): Record<string, McpServerConfig>` — read `<cwd>/.mcp.json`, normalize format, resolve env vars
- `filterMcpServers(servers, include?, exclude?): Record<string, McpServerConfig>` — standalone filter, easily pushable to per-node level later
- `resolveEnvVars(value: string): string` — internal helper, replaces `${VAR}` patterns from `process.env`
- `parseMcpJson(content: object): Record<string, McpServerConfig>` — internal helper, normalizes both flat and wrapped `.mcp.json` formats

**Project-level (per-run, merged inside `executeWorkflow()`):**
- Read `.mcp.json` from the workflow's working directory
- Merged on top of user plugins — **project overrides user on name collision** (more specific wins)
- Not cached — each workflow run may operate on a different repo

### Workflow YAML Schema

New optional top-level field `mcp_servers`:

```yaml
# No field → all discovered servers available (D default)
nodes:
  - id: update-issue
    prompt: "Update the Linear issue..."

# Explicit include — only these servers from the discovered set
mcp_servers:
  include: [linear]

# Explicit exclude — everything from discovered set except these
mcp_servers:
  exclude: [context-mode]
```

- `include` and `exclude` are mutually exclusive — validation error if both present
- Names match keys in the merged `Record<string, McpServerConfig>`
- Unknown names produce a **warning** at parse time, not an error (server may exist on another machine)
- Currently workflow-level only. Per-node scoping is a future extension — `filterMcpServers` is structured to support it without refactoring

### Integration

**`WorkflowDeps` (deps.ts):**
```typescript
interface WorkflowDeps {
  store: IWorkflowStore;
  getAssistantClient: AssistantClientFactory;
  loadConfig: (cwd: string) => Promise<WorkflowConfig>;
  mcpServers?: Record<string, McpServerConfig>;  // user plugins, cached at startup
}
```

**`createWorkflowDeps()` (store-adapter.ts):**
- Receives pre-discovered user MCP map (from server startup scan)
- Sets `deps.mcpServers` to the user plugin configs

**`executeWorkflow()` (executor.ts):**
1. Merge: `{ ...deps.mcpServers, ...discoverProjectMcpServers(cwd) }` — project overrides user
2. Filter: `filterMcpServers(merged, workflow.mcp_servers?.include, workflow.mcp_servers?.exclude)`
3. Pass filtered map as default `mcpServers` on all node options

**`dag-executor` node execution:**
- `nodeOptions.mcpServers = filteredMcpMap` (unless node-level override exists in the future)
- `ClaudeClient.sendQuery()` already passes `mcpServers` through to SDK — no changes needed

**Coexistence with existing `loadMcpConfig()`:**
- `dag-executor.ts` already has `loadMcpConfig()` (lines 263-296) which loads per-node MCP servers from an explicit JSON file path via the node's `mcp:` field. That mechanism stays as-is — it serves a different purpose (explicit config path vs. plugin ecosystem discovery).
- The new workflow-level passthrough is additive. If a node has both a `mcp:` field and the workflow-level passthrough, both sets of servers are available (node-level `mcp:` file takes precedence on name collision).

**Server startup (`index.ts` or equivalent):**
- Call `discoverUserMcpServers()` once
- Pass result to `createWorkflowDeps()`
- Log discovered servers at info level: `mcp.discovery_completed { count, names }`

### Files to Create/Modify

| File | Change |
|------|--------|
| `packages/core/src/mcp/discovery.ts` | **New** — `discoverUserMcpServers`, `discoverProjectMcpServers`, `filterMcpServers` |
| `packages/core/src/mcp/discovery.test.ts` | **New** — unit tests for discovery and filtering |
| `packages/workflows/src/deps.ts` | Add `mcpServers?` to `WorkflowDeps` |
| `packages/workflows/src/schemas/workflow.ts` | Add `mcp_servers` schema (include/exclude) |
| `packages/workflows/src/executor.ts` | Merge + filter MCP servers, pass to dag-executor |
| `packages/workflows/src/dag-executor.ts` | Set `nodeOptions.mcpServers` from filtered map |
| `packages/core/src/workflows/store-adapter.ts` | Accept MCP map in `createWorkflowDeps()` |
| `packages/server/src/index.ts` | Call `discoverUserMcpServers()` at startup, pass to deps |

### Verification

1. `bun run type-check` — no type errors
2. `bun run test` — all tests pass including new discovery tests
3. Manual: run a workflow that uses `/workflow run <name>` → verify Linear MCP tools appear in the agent's tool list
4. Manual: add `mcp_servers: { exclude: [linear] }` to a workflow YAML → verify Linear is NOT available
5. Manual: create a project-level `.mcp.json` → verify those servers are available in workflows targeting that repo

### What This Doesn't Cover

- **Built-in MCP servers** (like `memo`) — these don't come from plugins and aren't discoverable via `.mcp.json`. They'd need the SDK to load them natively, which requires `settingSources: ['user']` (rejected due to side effects).
- **Per-node MCP scoping** — future extension. The `filterMcpServers` function is structured to support it.
- **Dynamic MCP server registration** — adding servers mid-session without restart. Not needed for single-developer tool.
- **Codex SDK** — only Claude Code SDK supports `mcpServers` in query options. Codex workflows won't get MCP passthrough.
