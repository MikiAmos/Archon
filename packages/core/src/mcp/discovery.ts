/**
 * User MCP Plugin Discovery
 *
 * Discovers MCP servers from the user's installed Claude Code plugins.
 *
 * IMPORTANT: This module reads from the Claude Code directory structure
 * (~/.claude/plugins/) as of April 2026. This structure is not officially
 * documented and may change in future Claude Code releases.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from '@archon/paths';
import {
  parseMcpJson,
  resolveServerConfig,
  type McpServerMap,
} from '@archon/workflows/mcp/mcp-utils';

// --- Internal types ---

interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, { installPath: string; version?: string }[]>;
}

interface SettingsFile {
  enabledPlugins?: Record<string, boolean>;
}

// --- Logger (lazy init) ---

let cachedLog: ReturnType<typeof createLogger> | undefined;
function log(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('mcp.discovery');
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

async function readMcpFromPath(mcpPath: string): Promise<McpServerMap> {
  const raw = await readJsonFile<unknown>(mcpPath);
  if (raw === null) return {};

  const servers = parseMcpJson(raw);
  const missing: string[] = [];
  const resolved: McpServerMap = {};

  for (const [name, config] of Object.entries(servers)) {
    resolved[name] = resolveServerConfig(config, missing);
  }

  if (missing.length > 0) {
    log().warn({ missing, path: mcpPath }, 'mcp.env_vars_missing');
  }

  return resolved;
}

// --- Installed plugins (gated on enabledPlugins) ---

async function discoverInstalledPlugins(
  claudeDir: string,
  enabledPlugins: Record<string, boolean>
): Promise<McpServerMap> {
  const installedPath = join(claudeDir, 'plugins', 'installed_plugins.json');
  const installedFile = await readJsonFile<InstalledPluginsFile>(installedPath);
  if (!installedFile?.plugins) return {};

  const result: McpServerMap = {};

  for (const [pluginKey, installations] of Object.entries(installedFile.plugins)) {
    if (!enabledPlugins[pluginKey]) {
      log().debug({ pluginKey }, 'mcp.installed_plugin_skipped');
      continue;
    }

    for (const installation of installations) {
      const mcpPath = join(installation.installPath, '.mcp.json');
      const servers = await readMcpFromPath(mcpPath);
      Object.assign(result, servers);
    }
  }

  return result;
}

// --- External plugins (always included) ---

async function discoverExternalPlugins(claudeDir: string): Promise<McpServerMap> {
  const result: McpServerMap = {};
  const globPattern = 'plugins/marketplaces/*/external_plugins/*/.mcp.json';

  try {
    const glob = new Bun.Glob(globPattern);
    for await (const match of glob.scan({ cwd: claudeDir, absolute: true })) {
      const servers = await readMcpFromPath(match);
      Object.assign(result, servers);
    }
  } catch (err) {
    log().warn(
      { error: (err as Error).message, pattern: globPattern },
      'mcp.external_plugin_glob_failed'
    );
  }

  return result;
}

// --- Public API ---

/**
 * Discover MCP servers from the user's Claude Code plugins.
 *
 * Two categories:
 * 1. Installed plugins — gated on settings.json enabledPlugins
 * 2. External plugins — always included (not tracked in enabledPlugins)
 *
 * @param claudeDir - Override for testing. Defaults to ~/.claude
 */
export async function discoverUserMcpServers(claudeDir?: string): Promise<McpServerMap> {
  const dir = claudeDir ?? join(homedir(), '.claude');

  // Load settings for enabledPlugins
  const settings = await readJsonFile<SettingsFile>(join(dir, 'settings.json'));
  const enabledPlugins = settings?.enabledPlugins ?? {};

  // Discover both categories
  const [installed, external] = await Promise.all([
    discoverInstalledPlugins(dir, enabledPlugins),
    discoverExternalPlugins(dir),
  ]);

  const merged: McpServerMap = { ...installed, ...external };
  const names = Object.keys(merged);

  log().info({ count: names.length, names }, 'mcp.user_discovery_completed');

  return merged;
}
