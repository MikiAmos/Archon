import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'os';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { discoverUserMcpServers } from './discovery';

describe('discoverUserMcpServers', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mcp-discovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('discovers installed plugin with matching enabledPlugins entry', async () => {
    // Create the plugin install directory with .mcp.json
    const installPath = join(testDir, 'plugins', 'installed', 'my-plugin');
    mkdirSync(installPath, { recursive: true });
    writeFileSync(
      join(installPath, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'my-server': { command: 'my-mcp-server', args: ['--port', '3000'] },
        },
      })
    );

    // Create installed_plugins.json
    const pluginsDir = join(testDir, 'plugins');
    writeFileSync(
      join(pluginsDir, 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'my-plugin@marketplace': [{ installPath, version: '1.0.0' }],
        },
      })
    );

    // Create settings.json with the plugin enabled
    writeFileSync(
      join(testDir, 'settings.json'),
      JSON.stringify({
        enabledPlugins: { 'my-plugin@marketplace': true },
      })
    );

    const result = await discoverUserMcpServers(testDir);
    expect(result['my-server']).toBeDefined();
    expect(result['my-server']).toEqual({
      command: 'my-mcp-server',
      args: ['--port', '3000'],
    });
  });

  test('skips installed plugin not in enabledPlugins', async () => {
    // Create the plugin install directory with .mcp.json
    const installPath = join(testDir, 'plugins', 'installed', 'disabled-plugin');
    mkdirSync(installPath, { recursive: true });
    writeFileSync(
      join(installPath, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'disabled-server': { command: 'disabled-mcp-server' },
        },
      })
    );

    // Create installed_plugins.json
    const pluginsDir = join(testDir, 'plugins');
    writeFileSync(
      join(pluginsDir, 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'disabled-plugin@marketplace': [{ installPath }],
        },
      })
    );

    // Create settings.json with empty enabledPlugins
    writeFileSync(
      join(testDir, 'settings.json'),
      JSON.stringify({
        enabledPlugins: {},
      })
    );

    const result = await discoverUserMcpServers(testDir);
    expect(result['disabled-server']).toBeUndefined();
    expect(Object.keys(result)).toHaveLength(0);
  });

  test('discovers external plugins (always included, no enabledPlugins check)', async () => {
    // Create external plugin directory structure
    const externalDir = join(
      testDir,
      'plugins',
      'marketplaces',
      'test-market',
      'external_plugins',
      'linear'
    );
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(
      join(externalDir, '.mcp.json'),
      JSON.stringify({
        'linear-server': { type: 'sse', url: 'http://localhost:4000/sse' },
      })
    );

    // Create settings.json with empty enabledPlugins (should not matter for external)
    writeFileSync(
      join(testDir, 'settings.json'),
      JSON.stringify({
        enabledPlugins: {},
      })
    );

    const result = await discoverUserMcpServers(testDir);
    expect(result['linear-server']).toBeDefined();
    expect(result['linear-server']).toEqual({
      type: 'sse',
      url: 'http://localhost:4000/sse',
    });
  });

  test('returns empty when plugins directory missing', async () => {
    // testDir exists but has no plugins/ subdirectory
    const result = await discoverUserMcpServers(testDir);
    expect(result).toEqual({});
  });
});
