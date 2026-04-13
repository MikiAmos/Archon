import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'os';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
  resolveEnvVars,
  parseMcpJson,
  filterMcpServers,
  resolveServerConfig,
  discoverProjectMcpServers,
  type McpServerMap,
} from './mcp-utils';

// --- parseMcpJson ---

describe('parseMcpJson', () => {
  test('parses flat format (record of server configs)', () => {
    const input = {
      sqlite: { command: 'mcp-server-sqlite', args: ['--db', 'test.db'] },
      fetch: { type: 'sse', url: 'http://localhost:3000/sse' },
    };
    const result = parseMcpJson(input);
    expect(result).toEqual({
      sqlite: { command: 'mcp-server-sqlite', args: ['--db', 'test.db'] },
      fetch: { type: 'sse', url: 'http://localhost:3000/sse' },
    });
  });

  test('parses wrapped format ({ mcpServers: { ... } })', () => {
    const input = {
      mcpServers: {
        sqlite: { command: 'mcp-server-sqlite', args: ['--db', 'test.db'] },
      },
    };
    const result = parseMcpJson(input);
    expect(result).toEqual({
      sqlite: { command: 'mcp-server-sqlite', args: ['--db', 'test.db'] },
    });
  });

  test('returns empty for null input', () => {
    expect(parseMcpJson(null)).toEqual({});
  });

  test('returns empty for string input', () => {
    expect(parseMcpJson('not an object')).toEqual({});
  });

  test('returns empty for array input', () => {
    expect(parseMcpJson([1, 2, 3])).toEqual({});
  });
});

// --- resolveEnvVars ---

describe('resolveEnvVars', () => {
  beforeEach(() => {
    process.env.TEST_TOKEN = 'secret-123';
    process.env.BASE_URL = 'https://api.example.com';
  });

  afterEach(() => {
    delete process.env.TEST_TOKEN;
    delete process.env.BASE_URL;
  });

  test('resolves ${VAR} syntax', () => {
    const result = resolveEnvVars('Bearer ${TEST_TOKEN}');
    expect(result.value).toBe('Bearer secret-123');
    expect(result.missing).toEqual([]);
  });

  test('resolves $VAR_NAME syntax', () => {
    const result = resolveEnvVars('$BASE_URL/v1');
    expect(result.value).toBe('https://api.example.com/v1');
    expect(result.missing).toEqual([]);
  });

  test('collects missing vars', () => {
    const result = resolveEnvVars('Bearer ${MISSING_VAR}');
    expect(result.value).toBe('Bearer ');
    expect(result.missing).toEqual(['MISSING_VAR']);
  });

  test('returns input unchanged when no vars present', () => {
    const result = resolveEnvVars('plain string');
    expect(result.value).toBe('plain string');
    expect(result.missing).toEqual([]);
  });

  test('resolves multiple vars in one string', () => {
    const result = resolveEnvVars('${BASE_URL}/auth?token=${TEST_TOKEN}');
    expect(result.value).toBe('https://api.example.com/auth?token=secret-123');
    expect(result.missing).toEqual([]);
  });
});

// --- resolveServerConfig ---

describe('resolveServerConfig', () => {
  beforeEach(() => {
    process.env.TEST_TOKEN = 'secret-123';
    process.env.BASE_URL = 'https://api.example.com';
  });

  afterEach(() => {
    delete process.env.TEST_TOKEN;
    delete process.env.BASE_URL;
  });

  test('resolves env vars in stdio args', () => {
    const missing: string[] = [];
    const result = resolveServerConfig(
      { command: 'mcp-server', args: ['--token', '${TEST_TOKEN}'] },
      missing
    );
    expect(result).toEqual({ command: 'mcp-server', args: ['--token', 'secret-123'] });
    expect(missing).toEqual([]);
  });

  test('resolves env vars in sse headers', () => {
    const missing: string[] = [];
    const result = resolveServerConfig(
      {
        type: 'sse',
        url: 'http://localhost:3000/sse',
        headers: { Authorization: 'Bearer ${TEST_TOKEN}' },
      },
      missing
    );
    expect(result).toEqual({
      type: 'sse',
      url: 'http://localhost:3000/sse',
      headers: { Authorization: 'Bearer secret-123' },
    });
    expect(missing).toEqual([]);
  });

  test('resolves env vars in http headers', () => {
    const missing: string[] = [];
    const result = resolveServerConfig(
      { type: 'http', url: '${BASE_URL}/mcp', headers: { 'X-Api-Key': '${TEST_TOKEN}' } },
      missing
    );
    expect(result).toEqual({
      type: 'http',
      url: 'https://api.example.com/mcp',
      headers: { 'X-Api-Key': 'secret-123' },
    });
    expect(missing).toEqual([]);
  });

  test('collects missing vars into collector', () => {
    const missing: string[] = [];
    resolveServerConfig(
      { type: 'sse', url: 'http://localhost', headers: { Auth: '${NONEXISTENT_KEY}' } },
      missing
    );
    expect(missing).toEqual(['NONEXISTENT_KEY']);
  });
});

// --- filterMcpServers ---

describe('filterMcpServers', () => {
  const servers: McpServerMap = {
    sqlite: { command: 'mcp-server-sqlite' },
    fetch: { type: 'sse', url: 'http://localhost:3000/sse' },
    github: { type: 'http', url: 'https://github.mcp.io' },
  };

  test('no filter returns all servers (passthrough)', () => {
    const result = filterMcpServers(servers);
    expect(result).toEqual(servers);
  });

  test('include filters to only specified servers', () => {
    const result = filterMcpServers(servers, ['sqlite', 'github']);
    expect(Object.keys(result)).toEqual(['sqlite', 'github']);
  });

  test('exclude removes specified servers', () => {
    const result = filterMcpServers(servers, undefined, ['fetch']);
    expect(Object.keys(result)).toEqual(['sqlite', 'github']);
  });

  test('throws when both include and exclude are provided', () => {
    expect(() => filterMcpServers(servers, ['sqlite'], ['fetch'])).toThrow();
  });
});

// --- discoverProjectMcpServers ---

describe('discoverProjectMcpServers', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    process.env.TEST_TOKEN = 'secret-123';
    process.env.BASE_URL = 'https://api.example.com';
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.TEST_TOKEN;
    delete process.env.BASE_URL;
  });

  test('reads wrapped .mcp.json format', async () => {
    const mcpConfig = {
      mcpServers: {
        sqlite: { command: 'mcp-server-sqlite', args: ['--db', 'test.db'] },
      },
    };
    writeFileSync(join(testDir, '.mcp.json'), JSON.stringify(mcpConfig));

    const result = await discoverProjectMcpServers(testDir);
    expect(result).toEqual({
      sqlite: { command: 'mcp-server-sqlite', args: ['--db', 'test.db'] },
    });
  });

  test('reads flat .mcp.json format', async () => {
    const mcpConfig = {
      fetch: { type: 'sse', url: 'http://localhost:3000/sse' },
    };
    writeFileSync(join(testDir, '.mcp.json'), JSON.stringify(mcpConfig));

    const result = await discoverProjectMcpServers(testDir);
    expect(result).toEqual({
      fetch: { type: 'sse', url: 'http://localhost:3000/sse' },
    });
  });

  test('returns empty when .mcp.json is missing', async () => {
    const result = await discoverProjectMcpServers(testDir);
    expect(result).toEqual({});
  });

  test('resolves env vars in discovered configs', async () => {
    const mcpConfig = {
      mcpServers: {
        api: {
          type: 'sse',
          url: '${BASE_URL}/sse',
          headers: { Authorization: 'Bearer ${TEST_TOKEN}' },
        },
      },
    };
    writeFileSync(join(testDir, '.mcp.json'), JSON.stringify(mcpConfig));

    const result = await discoverProjectMcpServers(testDir);
    expect(result).toEqual({
      api: {
        type: 'sse',
        url: 'https://api.example.com/sse',
        headers: { Authorization: 'Bearer secret-123' },
      },
    });
  });
});
