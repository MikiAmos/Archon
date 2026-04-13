# MCP Server Passthrough Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make MCP tools (Linear, Supabase, etc.) from the user's installed Claude Code plugins available to workflow agent sessions.

**Architecture:** Discover MCP server configs from two sources (user plugins at startup, project `.mcp.json` per-run), merge them, apply workflow-level include/exclude filtering, and pass the filtered map to every DAG node's assistant options. Shared MCP utils live in `@archon/workflows` (both executor and core can access). User plugin discovery lives in `@archon/core` (reads `~/.claude/plugins/`).

**Tech Stack:** Bun, TypeScript, Zod, Claude Code SDK (`mcpServers` option)

**Design Doc:** `docs/superpowers/specs/2026-04-12-mcp-passthrough-design.md`

**Planning Context:**
- **Codebase surprises:** Dependency direction is `@archon/workflows` ← `@archon/core` (core depends on workflows, not the reverse — 17+ imports, zero the other way). `createWorkflowDeps()` called from 5 sites (orchestrator-agent ×3, orchestrator ×1, cli/workflow ×1). External plugins (Linear, Supabase) are NOT in `installed_plugins.json` or `enabledPlugins` — they're discovered by directory presence in `marketplaces/*/external_plugins/*/`. `enabledPlugins` is `Record<string, boolean>` tracking only installed plugins.
- **Key decisions:** Shared utils in `@archon/workflows/mcp/mcp-utils.ts` (not core — workflows can't import core). Cache passed as parameter to `createWorkflowDeps()` for testability (not module-level `let`). `Bun.Glob` for marketplace scanning (no new `glob` dependency). External plugins always included (not gated on `enabledPlugins`).
- **Assumptions & risks:** Plugin directory structure (`~/.claude/plugins/`) is Claude Code's internal layout — may change. Comment pinned in code. If `installed_plugins.json` doesn't exist, discovery returns empty for installed plugins but still scans external plugins.
- **Open questions:** None — all resolved.

---

## Task 1: Create MCP Utils Module in `@archon/workflows`

**Files:**
- Create: `packages/workflows/src/mcp/mcp-utils.ts`
- Create: `packages/workflows/src/mcp/mcp-utils.test.ts`
- Modify: `packages/workflows/package.json:5-19` (add export)

**Step 1: Write the failing tests**

Create `packages/workflows/src/mcp/mcp-utils.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  parseMcpJson,
  resolveEnvVars,
  filterMcpServers,
  discoverProjectMcpServers,
} from './mcp-utils';

describe('parseMcpJson', () => {
  test('parses flat format (external plugins like Linear)', () => {
    const result = parseMcpJson({
      linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
    });
    expect(result).toEqual({
      linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
    });
  });

  test('parses wrapped format (installed plugins like context-mode)', () => {
    const result = parseMcpJson({
      mcpServers: {
        'context-mode': { command: 'node', args: ['start.mjs'] },
      },
    });
    expect(result).toEqual({
      'context-mode': { command: 'node', args: ['start.mjs'] },
    });
  });

  test('returns empty record for invalid input', () => {
    expect(parseMcpJson(null as unknown)).toEqual({});
    expect(parseMcpJson('string' as unknown)).toEqual({});
    expect(parseMcpJson([])).toEqual({});
  });
});

describe('resolveEnvVars', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env.TEST_TOKEN = 'secret-123';
    process.env.BASE_URL = 'https://api.example.com';
  });

  afterEach(() => {
    // Restore only the keys we touched
    delete process.env.TEST_TOKEN;
    delete process.env.BASE_URL;
  });

  test('resolves ${VAR} syntax', () => {
    const { value, missing } = resolveEnvVars('--token ${TEST_TOKEN}');
    expect(value).toBe('--token secret-123');
    expect(missing).toEqual([]);
  });

  test('resolves $VAR_NAME syntax', () => {
    const { value, missing } = resolveEnvVars('--token $TEST_TOKEN');
    expect(value).toBe('--token secret-123');
    expect(missing).toEqual([]);
  });

  test('collects missing vars', () => {
    const { value, missing } = resolveEnvVars('${NONEXISTENT_VAR}');
    expect(value).toBe('');
    expect(missing).toEqual(['NONEXISTENT_VAR']);
  });

  test('returns string unchanged when no vars present', () => {
    const { value, missing } = resolveEnvVars('plain text');
    expect(value).toBe('plain text');
    expect(missing).toEqual([]);
  });
});

describe('filterMcpServers', () => {
  const servers = {
    linear: { type: 'http' as const, url: 'https://mcp.linear.app/mcp' },
    supabase: { command: 'npx', args: ['-y', 'supabase-mcp'] },
    'context-mode': { command: 'node', args: ['start.mjs'] },
  };

  test('returns all servers when no include/exclude', () => {
    expect(filterMcpServers(servers)).toEqual(servers);
  });

  test('filters to include list', () => {
    const result = filterMcpServers(servers, ['linear']);
    expect(Object.keys(result)).toEqual(['linear']);
  });

  test('filters out exclude list', () => {
    const result = filterMcpServers(servers, undefined, ['context-mode']);
    expect(Object.keys(result)).toEqual(['linear', 'supabase']);
  });

  test('throws when both include and exclude provided', () => {
    expect(() => filterMcpServers(servers, ['linear'], ['supabase'])).toThrow(
      'mutually exclusive'
    );
  });
});

describe('discoverProjectMcpServers', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('reads .mcp.json from cwd (wrapped format)', async () => {
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          supabase: { command: 'npx', args: ['-y', 'supabase-mcp'] },
        },
      })
    );
    const result = await discoverProjectMcpServers(tmpDir);
    expect(result).toEqual({
      supabase: { command: 'npx', args: ['-y', 'supabase-mcp'] },
    });
  });

  test('reads .mcp.json from cwd (flat format)', async () => {
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
      })
    );
    const result = await discoverProjectMcpServers(tmpDir);
    expect(result).toEqual({
      linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
    });
  });

  test('returns empty when .mcp.json missing', async () => {
    const result = await discoverProjectMcpServers(tmpDir);
    expect(result).toEqual({});
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/workflows/src/mcp/mcp-utils.test.ts`
Expected: FAIL — module `./mcp-utils` not found

**Step 3: Write the utils module**

Create `packages/workflows/src/mcp/mcp-utils.ts`:

```typescript
/**
 * Shared MCP server utilities — parsing, env var resolution, filtering.
 * Lives in @archon/workflows so both executor (local) and core (via package dep) can use it.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@archon/paths';

/** Structural match for WorkflowAssistantOptions['mcpServers'] value type */
export type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

export type McpServerMap = Record<string, McpServerConfig>;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog() {
  if (!cachedLog) cachedLog = createLogger('mcp');
  return cachedLog;
}

// ---------------------------------------------------------------------------
// Env var resolution
// ---------------------------------------------------------------------------

/**
 * Resolve both ${VAR} and $VAR_NAME env var references from process.env.
 * Returns the resolved string and a list of missing variable names.
 */
export function resolveEnvVars(input: string): { value: string; missing: string[] } {
  const missing: string[] = [];
  const value = input.replace(
    /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g,
    (_, braced: string | undefined, bare: string | undefined) => {
      const varName = braced ?? bare;
      if (!varName) return '';
      const envVal = process.env[varName];
      if (envVal === undefined) missing.push(varName);
      return envVal ?? '';
    }
  );
  return { value, missing };
}

// ---------------------------------------------------------------------------
// .mcp.json parsing
// ---------------------------------------------------------------------------

/**
 * Normalize both .mcp.json formats to Record<string, McpServerConfig>.
 * - Flat:    { "server-name": { "type": "http", ... } }
 * - Wrapped: { "mcpServers": { "server-name": { ... } } }
 */
export function parseMcpJson(content: unknown): McpServerMap {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return {};
  const obj = content as Record<string, unknown>;

  // Wrapped format: has mcpServers key with object value
  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    return obj.mcpServers as McpServerMap;
  }

  // Flat format: top-level keys are server names
  return obj as McpServerMap;
}

// ---------------------------------------------------------------------------
// Server config env var resolution
// ---------------------------------------------------------------------------

/** Resolve env vars in a server config's args array (stdio) or headers (sse/http). */
export function resolveServerConfig(
  config: McpServerConfig,
  missingCollector: string[]
): McpServerConfig {
  const c = config as Record<string, unknown>;

  // Resolve args for stdio servers
  if (Array.isArray(c.args)) {
    const missing: string[] = [];
    const resolved = (c.args as unknown[]).map(arg => {
      if (typeof arg !== 'string') return String(arg);
      const result = resolveEnvVars(arg);
      missing.push(...result.missing);
      return result.value;
    });
    missingCollector.push(...missing);
    return { ...config, args: resolved } as McpServerConfig;
  }

  // Resolve headers for sse/http servers
  if (c.headers && typeof c.headers === 'object') {
    const resolvedHeaders: Record<string, string> = {};
    for (const [key, val] of Object.entries(c.headers as Record<string, string>)) {
      const { value, missing } = resolveEnvVars(val);
      missingCollector.push(...missing);
      resolvedHeaders[key] = value;
    }
    return { ...config, headers: resolvedHeaders } as McpServerConfig;
  }

  return config;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Filter MCP servers by include/exclude lists.
 * Standalone function — designed to be pushable to per-node level later.
 */
export function filterMcpServers(
  servers: McpServerMap,
  include?: string[],
  exclude?: string[]
): McpServerMap {
  if (include && exclude) {
    throw new Error("mcp_servers 'include' and 'exclude' are mutually exclusive");
  }
  if (!include && !exclude) return servers;

  if (include) {
    const includeSet = new Set(include);
    const filtered: McpServerMap = {};
    for (const [name, config] of Object.entries(servers)) {
      if (includeSet.has(name)) filtered[name] = config;
    }
    return filtered;
  }

  const excludeSet = new Set(exclude);
  const filtered: McpServerMap = {};
  for (const [name, config] of Object.entries(servers)) {
    if (!excludeSet.has(name)) filtered[name] = config;
  }
  return filtered;
}

// ---------------------------------------------------------------------------
// Project-level discovery
// ---------------------------------------------------------------------------

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Discover MCP servers from a project's .mcp.json file.
 * Returns empty record if file doesn't exist.
 */
export async function discoverProjectMcpServers(cwd: string): Promise<McpServerMap> {
  const mcpContent = await readJsonFile<unknown>(join(cwd, '.mcp.json'));
  if (!mcpContent) return {};

  const parsed = parseMcpJson(mcpContent);
  const allMissing: string[] = [];
  const servers: McpServerMap = {};

  for (const [name, config] of Object.entries(parsed)) {
    servers[name] = resolveServerConfig(config, allMissing);
  }

  if (allMissing.length > 0) {
    getLog().warn({ cwd, missingVars: [...new Set(allMissing)] }, 'mcp.project_env_vars_missing');
  }

  if (Object.keys(servers).length > 0) {
    getLog().info(
      { count: Object.keys(servers).length, names: Object.keys(servers), cwd },
      'mcp.project_discovery_completed'
    );
  }
  return servers;
}
```

**Step 4: Add export to `packages/workflows/package.json`**

Add to exports map (after `"./utils/tool-formatter"` line):

```json
"./mcp/mcp-utils": "./src/mcp/mcp-utils.ts"
```

**Step 5: Run tests to verify they pass**

Run: `bun test packages/workflows/src/mcp/mcp-utils.test.ts`
Expected: All pass

**Step 6: Add test to workflows package.json test script**

Append `&& bun test src/mcp/` to the test script in `packages/workflows/package.json`.

**Step 7: Run full workflow tests**

Run: `bun --filter @archon/workflows test`
Expected: All pass

**Step 8: Commit**

```bash
git add packages/workflows/src/mcp/mcp-utils.ts packages/workflows/src/mcp/mcp-utils.test.ts packages/workflows/package.json
git commit -m "feat(mcp): add shared MCP utils module — parsing, env vars, filtering, project discovery"
```

---

## Task 2: Create User Plugin Discovery in `@archon/core`

**Files:**
- Create: `packages/core/src/mcp/discovery.ts`
- Create: `packages/core/src/mcp/discovery.test.ts`

**Step 1: Write the failing tests**

Create `packages/core/src/mcp/discovery.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { discoverUserMcpServers } from './discovery';

describe('discoverUserMcpServers', () => {
  let tmpClaudeDir: string;

  beforeEach(() => {
    tmpClaudeDir = join(
      tmpdir(),
      `claude-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(join(tmpClaudeDir, 'plugins/marketplaces/test-market/external_plugins/linear'), {
      recursive: true,
    });
  });

  afterEach(() => {
    rmSync(tmpClaudeDir, { recursive: true, force: true });
  });

  test('discovers installed plugin with matching enabledPlugins entry', async () => {
    const installPath = join(tmpClaudeDir, 'plugins/cache/test-plugin/1.0.0');
    mkdirSync(installPath, { recursive: true });
    writeFileSync(
      join(installPath, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'test-server': { command: 'node', args: ['start.js'] } } })
    );
    writeFileSync(
      join(tmpClaudeDir, 'plugins/installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { 'test-plugin@test-market': [{ installPath }] },
      })
    );
    writeFileSync(
      join(tmpClaudeDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'test-plugin@test-market': true } })
    );

    const result = await discoverUserMcpServers(tmpClaudeDir);
    expect(result['test-server']).toBeDefined();
    expect((result['test-server'] as { command: string }).command).toBe('node');
  });

  test('skips installed plugin not in enabledPlugins', async () => {
    const installPath = join(tmpClaudeDir, 'plugins/cache/disabled/1.0.0');
    mkdirSync(installPath, { recursive: true });
    writeFileSync(
      join(installPath, '.mcp.json'),
      JSON.stringify({ mcpServers: { disabled: { command: 'node', args: ['x.js'] } } })
    );
    writeFileSync(
      join(tmpClaudeDir, 'plugins/installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { 'disabled@test': [{ installPath }] },
      })
    );
    writeFileSync(
      join(tmpClaudeDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: {} })
    );

    const result = await discoverUserMcpServers(tmpClaudeDir);
    expect(result['disabled']).toBeUndefined();
  });

  test('discovers external plugins (always included, no enabledPlugins check)', async () => {
    writeFileSync(
      join(tmpClaudeDir, 'plugins/marketplaces/test-market/external_plugins/linear/.mcp.json'),
      JSON.stringify({ linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } })
    );
    // No enabledPlugins entry for linear — external plugins don't need one
    writeFileSync(
      join(tmpClaudeDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: {} })
    );

    const result = await discoverUserMcpServers(tmpClaudeDir);
    expect(result['linear']).toBeDefined();
    expect((result['linear'] as { type: string }).type).toBe('http');
  });

  test('returns empty when plugins directory missing', async () => {
    const emptyDir = join(tmpdir(), `empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    try {
      const result = await discoverUserMcpServers(emptyDir);
      expect(result).toEqual({});
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/core/src/mcp/discovery.test.ts`
Expected: FAIL — module not found

**Step 3: Write the discovery module**

Create `packages/core/src/mcp/discovery.ts`:

```typescript
/**
 * User-level MCP server discovery — reads Claude Code plugin configs.
 *
 * IMPORTANT: Directory structure (installed_plugins.json, marketplaces/) is
 * Claude Code's internal layout as of April 2026. This may change between
 * versions — see https://docs.anthropic.com/en/docs/claude-code for updates.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '@archon/paths';
import {
  parseMcpJson,
  resolveServerConfig,
  type McpServerMap,
} from '@archon/workflows/mcp/mcp-utils';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog() {
  if (!cachedLog) cachedLog = createLogger('mcp.discovery');
  return cachedLog;
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, Array<{ installPath: string; version?: string }>>;
}

/**
 * Discover MCP servers from the user's installed Claude Code plugins.
 *
 * Two categories (different tracking mechanisms):
 * 1. Installed plugins — from installed_plugins.json, gated on enabledPlugins in settings.json
 * 2. External plugins — from marketplaces/*/external_plugins/*/.mcp.json, always included
 *
 * @param claudeDir — override for testing (defaults to ~/.claude)
 */
export async function discoverUserMcpServers(
  claudeDir?: string
): Promise<McpServerMap> {
  const dir = claudeDir ?? join(homedir(), '.claude');
  const pluginsDir = join(dir, 'plugins');
  const servers: McpServerMap = {};
  const allMissing: string[] = [];

  // Read enabled plugins list (Record<"name@marketplace", boolean>)
  const settings = await readJsonFile<{ enabledPlugins?: Record<string, boolean> }>(
    join(dir, 'settings.json')
  );
  const enabledPlugins = settings?.enabledPlugins ?? {};

  // 1. Installed plugins (from installed_plugins.json, gated on enabledPlugins)
  const installedFile = await readJsonFile<InstalledPluginsFile>(
    join(pluginsDir, 'installed_plugins.json')
  );

  if (installedFile?.plugins) {
    for (const [pluginKey, entries] of Object.entries(installedFile.plugins)) {
      // Only include if explicitly enabled
      if (!enabledPlugins[pluginKey]) {
        getLog().debug({ pluginKey }, 'mcp.installed_plugin_not_enabled');
        continue;
      }
      const meta = entries[0]; // First entry is the active installation
      if (!meta?.installPath) continue;

      const mcpPath = join(meta.installPath, '.mcp.json');
      const mcpContent = await readJsonFile<unknown>(mcpPath);
      if (!mcpContent) {
        getLog().debug({ pluginKey, mcpPath }, 'mcp.installed_plugin_no_mcp_json');
        continue;
      }
      const parsed = parseMcpJson(mcpContent);
      for (const [name, config] of Object.entries(parsed)) {
        servers[name] = resolveServerConfig(config, allMissing);
      }
    }
  }

  // 2. External plugins (always included — not tracked in enabledPlugins)
  // Use Bun.Glob instead of npm glob to avoid adding a dependency
  try {
    const glob = new Bun.Glob('marketplaces/*/external_plugins/*/.mcp.json');
    for await (const match of glob.scan({ cwd: pluginsDir, absolute: true })) {
      const mcpContent = await readJsonFile<unknown>(match);
      if (!mcpContent) continue;
      const parsed = parseMcpJson(mcpContent);
      for (const [name, config] of Object.entries(parsed)) {
        servers[name] = resolveServerConfig(config, allMissing);
      }
    }
  } catch (err) {
    getLog().warn({ err }, 'mcp.external_plugins_scan_failed');
  }

  if (allMissing.length > 0) {
    getLog().warn({ missingVars: [...new Set(allMissing)] }, 'mcp.env_vars_missing');
  }

  getLog().info(
    { count: Object.keys(servers).length, names: Object.keys(servers) },
    'mcp.user_discovery_completed'
  );
  return servers;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/core/src/mcp/discovery.test.ts`
Expected: All pass

**Step 5: Add to core test script**

Add `bun test src/mcp/` to the test script in `packages/core/package.json`.

**Step 6: Commit**

```bash
git add packages/core/src/mcp/discovery.ts packages/core/src/mcp/discovery.test.ts packages/core/package.json
git commit -m "feat(mcp): add user plugin discovery — installed + external plugins"
```

---

## Task 3: Add `mcp_servers` to Workflow YAML Schema

**Files:**
- Modify: `packages/workflows/src/schemas/workflow.ts:29-43`

**Step 1: Write the failing test**

Add to `packages/workflows/src/schemas.test.ts` (or create if needed):

```typescript
describe('mcp_servers schema field', () => {
  test('accepts mcp_servers with include', () => {
    const result = workflowDefinitionSchema.safeParse({
      name: 'test', description: 'test',
      mcp_servers: { include: ['linear'] },
      nodes: [{ id: 'a', prompt: 'do something' }],
    });
    expect(result.success).toBe(true);
  });

  test('accepts mcp_servers with exclude', () => {
    const result = workflowDefinitionSchema.safeParse({
      name: 'test', description: 'test',
      mcp_servers: { exclude: ['context-mode'] },
      nodes: [{ id: 'a', prompt: 'do something' }],
    });
    expect(result.success).toBe(true);
  });

  test('rejects mcp_servers with both include and exclude', () => {
    const result = workflowDefinitionSchema.safeParse({
      name: 'test', description: 'test',
      mcp_servers: { include: ['linear'], exclude: ['supabase'] },
      nodes: [{ id: 'a', prompt: 'do something' }],
    });
    expect(result.success).toBe(false);
  });

  test('accepts workflow with no mcp_servers field', () => {
    const result = workflowDefinitionSchema.safeParse({
      name: 'test', description: 'test',
      nodes: [{ id: 'a', prompt: 'do something' }],
    });
    expect(result.success).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Expected: FAIL — `mcp_servers` not in schema

**Step 3: Add `mcp_servers` to `workflowBaseSchema`**

In `packages/workflows/src/schemas/workflow.ts`, before `workflowBaseSchema`:

```typescript
const mcpServersFilterSchema = z
  .object({
    include: z.array(z.string().min(1)).optional(),
    exclude: z.array(z.string().min(1)).optional(),
  })
  .refine((data) => !(data.include && data.exclude), {
    message: "mcp_servers 'include' and 'exclude' are mutually exclusive",
  });
```

Then add to `workflowBaseSchema` after `sandbox`:

```typescript
mcp_servers: mcpServersFilterSchema.optional(),
```

**Step 4: Run test to verify it passes**

**Step 5: Commit**

```bash
git add packages/workflows/src/schemas/workflow.ts packages/workflows/src/schemas.test.ts
git commit -m "feat(workflows): add mcp_servers schema field (include/exclude) to workflow definition"
```

---

## Task 4: Wire `mcpServers` into `WorkflowDeps` and `createWorkflowDeps()`

**Files:**
- Modify: `packages/workflows/src/deps.ts:273-277`
- Modify: `packages/core/src/workflows/store-adapter.ts:69-75`
- Modify: `packages/core/src/workflows/store-adapter.test.ts`
- Modify: `packages/core/src/orchestrator/orchestrator-agent.ts` (3 call sites)
- Modify: `packages/core/src/orchestrator/orchestrator.ts:343`
- Modify: `packages/cli/src/commands/workflow.ts:598`

**Step 1: Add `mcpServers?` to `WorkflowDeps`**

In `packages/workflows/src/deps.ts:273-277`, add after `loadConfig`:

```typescript
export interface WorkflowDeps {
  store: IWorkflowStore;
  getAssistantClient: AssistantClientFactory;
  loadConfig: (cwd: string) => Promise<WorkflowConfig>;
  /** User-level MCP servers discovered at startup. Cached — not re-scanned per run. */
  mcpServers?: Record<
    string,
    | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
    | { type: 'sse'; url: string; headers?: Record<string, string> }
    | { type: 'http'; url: string; headers?: Record<string, string> }
  >;
}
```

**Step 2: Make `createWorkflowDeps()` async with injectable cache**

In `packages/core/src/workflows/store-adapter.ts`:

```typescript
import { discoverUserMcpServers } from '../mcp/discovery';
import type { McpServerMap } from '@archon/workflows/mcp/mcp-utils';

// Singleton discovery — runs once per process, result reused.
let discoveredMcpServers: McpServerMap | undefined;
async function discoverOnce(): Promise<McpServerMap> {
  if (!discoveredMcpServers) {
    discoveredMcpServers = await discoverUserMcpServers();
  }
  return discoveredMcpServers;
}

/** Reset discovery cache — for testing only. */
export function _resetMcpDiscoveryCache(): void {
  discoveredMcpServers = undefined;
}

/**
 * Create the canonical WorkflowDeps for the workflow engine.
 * @param mcpServers — optional override for testing (skips user plugin discovery)
 */
export async function createWorkflowDeps(mcpServers?: McpServerMap): Promise<WorkflowDeps> {
  const servers = mcpServers ?? await discoverOnce();
  return {
    store: createWorkflowStore(),
    getAssistantClient,
    loadConfig: loadMergedConfig,
    mcpServers: Object.keys(servers).length > 0 ? servers : undefined,
  };
}
```

**Step 3: Update all 5 call sites to `await`**

Each of these lines needs `await` added — all are already inside async functions:

- `packages/core/src/orchestrator/orchestrator-agent.ts:270`: `await createWorkflowDeps()`
- `packages/core/src/orchestrator/orchestrator-agent.ts:282`: `await createWorkflowDeps()`
- `packages/core/src/orchestrator/orchestrator-agent.ts:308`: `await createWorkflowDeps()`
- `packages/core/src/orchestrator/orchestrator.ts:343`: `const workflowDeps = await createWorkflowDeps();`
- `packages/cli/src/commands/workflow.ts:598`: `await createWorkflowDeps()`

**Step 4: Update store-adapter tests**

In `packages/core/src/workflows/store-adapter.test.ts`, change `createWorkflowDeps()` calls to `await createWorkflowDeps({})` (pass empty map to skip real discovery):

```typescript
test('createWorkflowDeps returns all required fields', async () => {
  const deps = await createWorkflowDeps({});
  expect(deps.store).toBeDefined();
  expect(deps.mcpServers).toBeUndefined(); // empty map → undefined
});
```

**Step 5: Run type-check + tests**

Run: `bun run type-check && bun run test`
Expected: All pass

**Step 6: Commit**

```bash
git add packages/workflows/src/deps.ts \
  packages/core/src/workflows/store-adapter.ts \
  packages/core/src/workflows/store-adapter.test.ts \
  packages/core/src/orchestrator/orchestrator-agent.ts \
  packages/core/src/orchestrator/orchestrator.ts \
  packages/cli/src/commands/workflow.ts
git commit -m "feat(mcp): wire discovered MCP servers into WorkflowDeps (async createWorkflowDeps)"
```

---

## Task 5: Merge + Filter in `executeWorkflow()` and Inject into DAG Nodes

**Files:**
- Modify: `packages/workflows/src/executor.ts` (inside `executeWorkflow`, around line 248-254)
- Modify: `packages/workflows/src/dag-executor.ts:2360-2385` (signature) and `dag-executor.ts:519` (node loop)

**Step 1: Add merge + filter in `executeWorkflow()`**

In `packages/workflows/src/executor.ts`, after config loading (around line 254), add:

```typescript
import { discoverProjectMcpServers, filterMcpServers } from './mcp/mcp-utils';
import type { McpServerMap } from './mcp/mcp-utils';

// Inside executeWorkflow, after config loading:
// Merge MCP servers: user plugins (cached on deps) + project-level (per-run)
const projectMcpServers = await discoverProjectMcpServers(cwd);
const mergedMcpServers: McpServerMap = { ...deps.mcpServers, ...projectMcpServers };
const filteredMcpServers = Object.keys(mergedMcpServers).length > 0
  ? filterMcpServers(
      mergedMcpServers,
      workflow.mcp_servers?.include,
      workflow.mcp_servers?.exclude
    )
  : undefined;
```

Pass `filteredMcpServers` to `executeDagWorkflow` as a new parameter.

**Step 2: Update `executeDagWorkflow` signature**

In `packages/workflows/src/dag-executor.ts:2360-2377`, add new parameter after `priorCompletedNodes`:

```typescript
export async function executeDagWorkflow(
  // ... existing params ...
  priorCompletedNodes?: Map<string, string>,
  workflowMcpServers?: McpServerMap
): Promise<string | undefined> {
```

Also import `McpServerMap` from `./mcp/mcp-utils`.

Thread `workflowMcpServers` down to the node execution loop (pass it to internal execute functions that handle node options).

**Step 3: Inject workflow-level MCP into DAG node options**

In the node execution loop (around line 519), BEFORE the existing per-node `mcp:` block:

```typescript
// Inject workflow-level MCP servers as base
if (workflowMcpServers && Object.keys(workflowMcpServers).length > 0) {
  // Start with workflow-level servers
  let mergedMcp: Record<string, unknown> = { ...workflowMcpServers };

  if (node.mcp) {
    // Per-node mcp: file overrides workflow-level on name collision
    try {
      const { servers, serverNames, missingVars } = await loadMcpConfig(node.mcp, cwd);
      Object.assign(mergedMcp, servers); // node wins on collision
      if (missingVars.length > 0) {
        // ... existing missingVars warning code (reuse)
      }
    } catch (mcpErr) {
      const errMsg = (mcpErr as Error).message;
      getLog().error({ nodeId: node.id, mcpPath: node.mcp, error: errMsg }, 'dag.mcp_config_load_failed');
      throw new Error(`Node '${node.id}': ${errMsg}`);
    }
  }

  claudeOptions.mcpServers = mergedMcp as unknown as WorkflowAssistantOptions['mcpServers'];
  const mcpWildcards = Object.keys(mergedMcp).map(name => `mcp__${name}__*`);
  claudeOptions.allowedTools = [...(claudeOptions.allowedTools ?? []), ...mcpWildcards];
  getLog().info(
    { nodeId: node.id, serverNames: Object.keys(mergedMcp), hasNodeMcp: !!node.mcp },
    'dag.mcp_servers_injected'
  );
} else if (node.mcp) {
  // No workflow-level MCP — use existing per-node mcp: handling as-is
  // (existing code block at line 519, unchanged)
}
```

**Important:** The existing per-node `mcp:` block (lines 519-570) should become the `else if` branch. The workflow-level MCP becomes the primary path, with per-node merged in when both exist.

**Step 4: Update the call site in `executeWorkflow`**

In `packages/workflows/src/executor.ts` where `executeDagWorkflow` is called (line 622), add the new parameter:

```typescript
const dagSummary = await executeDagWorkflow(
  deps, platform, conversationId, cwd, workflow, workflowRun,
  resolvedProvider, resolvedModel, artifactsDir, logDir,
  baseBranch, docsDir, config, configuredCommandFolder,
  issueContext, dagPriorCompletedNodes,
  filteredMcpServers  // new parameter
);
```

**Step 5: Run type-check + tests**

Run: `bun run type-check && bun run test`
Expected: All pass

**Step 6: Commit**

```bash
git add packages/workflows/src/executor.ts packages/workflows/src/dag-executor.ts
git commit -m "feat(mcp): merge and inject discovered MCP servers into DAG node execution"
```

---

## Task 6: Integration Test — Merge + Inject Flow

**Files:**
- Create or extend: `packages/workflows/src/dag-executor.test.ts` (add MCP merge tests)

**Step 1: Write integration tests for MCP merge + inject**

```typescript
describe('workflow-level MCP server injection', () => {
  test('workflow-level MCP servers injected when no per-node mcp', async () => {
    // Setup: workflow with mcpServers on deps, node without mcp: field
    // Assert: claudeOptions.mcpServers contains the workflow-level servers
    // Assert: claudeOptions.allowedTools contains mcp__<name>__* wildcards
  });

  test('per-node mcp: overrides workflow-level on name collision', async () => {
    // Setup: workflow-level has { linear: { url: 'old' } }
    // Node has mcp: pointing to file with { linear: { url: 'new' } }
    // Assert: claudeOptions.mcpServers.linear has the node-level config
  });

  test('both workflow-level and per-node servers merged when no collision', async () => {
    // Setup: workflow-level has { linear: {...} }, node mcp: has { supabase: {...} }
    // Assert: claudeOptions.mcpServers has both linear and supabase
  });

  test('workflow include filter applies before injection', async () => {
    // Setup: workflow has mcp_servers: { include: ['linear'] }
    // deps.mcpServers has linear + supabase + context-mode
    // Assert: only linear reaches the node
  });

  test('workflow exclude filter applies before injection', async () => {
    // Setup: workflow has mcp_servers: { exclude: ['context-mode'] }
    // deps.mcpServers has linear + supabase + context-mode
    // Assert: linear + supabase reach the node, context-mode doesn't
  });
});
```

**Step 2: Run tests**

Run: `bun test packages/workflows/src/dag-executor.test.ts`
Expected: All pass

**Step 3: Commit**

```bash
git add packages/workflows/src/dag-executor.test.ts
git commit -m "test(mcp): integration tests for workflow-level MCP merge and injection"
```

---

## Task 7: End-to-End Validation

**Step 1: Type check**

Run: `bun run type-check`
Expected: No errors

**Step 2: Full test suite**

Run: `bun run test`
Expected: All pass

**Step 3: Full validation**

Run: `bun run validate`
Expected: All pass

**Step 4: Manual verification**

1. Start the dev server: `bun run dev:server`
2. Run a workflow via web UI or CLI: `/workflow run <name>`
3. Check server logs for `mcp.user_discovery_completed { count, names }` — confirms user plugins discovered
4. In the workflow agent's tool list, verify MCP tools appear (e.g., Linear tools)
5. Add `mcp_servers: { exclude: [linear] }` to a test workflow YAML → re-run → verify Linear tools NOT available
6. Create a project-level `.mcp.json` → verify those servers are available in workflows

**Step 5: Final commit (if any fixups needed)**
