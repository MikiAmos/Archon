/**
 * MCP Server Configuration Utilities
 *
 * Shared foundation for MCP server passthrough — parsing .mcp.json,
 * resolving env vars, and filtering server configs.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { createLogger } from '@archon/paths';

// --- Types ---

/** Structural match for WorkflowAssistantOptions['mcpServers'] value type */
export type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

export type McpServerMap = Record<string, McpServerConfig>;

// --- Logger (lazy init) ---

let cachedLog: ReturnType<typeof createLogger> | undefined;
function log(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('mcp');
  return cachedLog;
}

// --- Internal helpers ---

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

// --- Public API ---

const ENV_VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g;

/**
 * Resolve `${VAR}` and `$VAR_NAME` env var references from process.env.
 * Returns the resolved string and a list of missing variable names.
 */
export function resolveEnvVars(input: string): { value: string; missing: string[] } {
  const missing: string[] = [];
  const value = input.replace(
    ENV_VAR_RE,
    (_match, braced: string | undefined, bare: string | undefined) => {
      // Regex guarantees one of braced or bare will match
      const name = braced ?? bare ?? '';
      const val = process.env[name];
      if (val === undefined) {
        missing.push(name);
        return '';
      }
      return val;
    }
  );
  return { value, missing };
}

/**
 * Normalize both flat `{ "name": { config } }` and wrapped
 * `{ "mcpServers": { "name": { config } } }` formats into McpServerMap.
 */
export function parseMcpJson(content: unknown): McpServerMap {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    return {};
  }

  const obj = content as Record<string, unknown>;

  // Wrapped format: { mcpServers: { ... } }
  if (
    'mcpServers' in obj &&
    obj.mcpServers !== null &&
    typeof obj.mcpServers === 'object' &&
    !Array.isArray(obj.mcpServers)
  ) {
    return obj.mcpServers as McpServerMap;
  }

  // Flat format: treat the whole object as the server map
  return obj as McpServerMap;
}

/**
 * Resolve env vars in a server config's dynamic fields:
 * - stdio: args, env values
 * - sse/http: url, header values
 *
 * Missing env var names are appended to `missingCollector`.
 */
export function resolveServerConfig(
  config: McpServerConfig,
  missingCollector: string[]
): McpServerConfig {
  if (config.type === 'sse' || config.type === 'http') {
    const { value: url, missing: urlMissing } = resolveEnvVars(config.url);
    missingCollector.push(...urlMissing);

    let headers: Record<string, string> | undefined;
    if (config.headers) {
      headers = {};
      for (const [key, val] of Object.entries(config.headers)) {
        const { value, missing } = resolveEnvVars(val);
        missingCollector.push(...missing);
        headers[key] = value;
      }
    }

    return { ...config, url, ...(headers ? { headers } : {}) };
  }

  // stdio (type is undefined or 'stdio')
  const stdioConfig = config as {
    type?: 'stdio';
    command: string;
    args?: string[];
    env?: Record<string, string>;
  };

  let args: string[] | undefined;
  if (stdioConfig.args) {
    args = stdioConfig.args.map(arg => {
      const { value, missing } = resolveEnvVars(arg);
      missingCollector.push(...missing);
      return value;
    });
  }

  let env: Record<string, string> | undefined;
  if (stdioConfig.env) {
    env = {};
    for (const [key, val] of Object.entries(stdioConfig.env)) {
      const { value, missing } = resolveEnvVars(val);
      missingCollector.push(...missing);
      env[key] = value;
    }
  }

  return {
    ...stdioConfig,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
  };
}

/**
 * Filter servers by include/exclude lists. Mutually exclusive — throws if both provided.
 * No filter = passthrough (returns all servers).
 */
export function filterMcpServers(
  servers: McpServerMap,
  include?: string[],
  exclude?: string[]
): McpServerMap {
  if (include && exclude) {
    throw new Error('Cannot specify both include and exclude for MCP server filtering');
  }

  if (!include && !exclude) {
    return servers;
  }

  if (include) {
    const result: McpServerMap = {};
    for (const name of include) {
      if (name in servers) {
        result[name] = servers[name];
      }
    }
    return result;
  }

  // exclude
  const excludeSet = new Set(exclude);
  const result: McpServerMap = {};
  for (const [name, config] of Object.entries(servers)) {
    if (!excludeSet.has(name)) {
      result[name] = config;
    }
  }
  return result;
}

/**
 * Read `.mcp.json` from a project directory, parse, and resolve env vars.
 * Returns empty map if file is missing or unparseable.
 */
export async function discoverProjectMcpServers(cwd: string): Promise<McpServerMap> {
  const filePath = join(cwd, '.mcp.json');
  const raw = await readJsonFile<unknown>(filePath);
  if (raw === null) {
    return {};
  }

  const servers = parseMcpJson(raw);
  const missing: string[] = [];
  const resolved: McpServerMap = {};

  for (const [name, config] of Object.entries(servers)) {
    resolved[name] = resolveServerConfig(config, missing);
  }

  if (missing.length > 0) {
    log().warn({ missing, path: filePath }, 'mcp.env_vars_missing');
  }

  return resolved;
}
