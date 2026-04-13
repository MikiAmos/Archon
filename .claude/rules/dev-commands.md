---
paths:
  - "packages/**/*.ts"
  - ".eslintrc.*"
  - "eslint.config.*"
---

# Development Guidelines & Patterns

## ESLint Guidelines

**Zero-tolerance policy**: CI enforces `--max-warnings 0`. No warnings allowed.

**When to use inline disable comments** (`// eslint-disable-next-line`):
- **Almost never** - fix the issue instead
- Only acceptable when:
  1. External SDK types are incorrect (document which SDK and why)
  2. Intentional type assertion after validation (must include comment explaining the validation)

**Never acceptable:**
- Disabling `no-explicit-any` without justification
- Disabling rules to "make CI pass"
- Bulk disabling at file level (`/* eslint-disable */`)

## When Creating New Features

**Quick reference:**
- **Platform Adapters**: Implement `IPlatformAdapter`, handle auth, polling/webhooks
- **AI Clients**: Implement `IAssistantClient`, session management, streaming
- **Slash Commands**: Add to command-handler.ts, update database, no AI
- **Database Operations**: Use `IDatabase` interface (supports PostgreSQL and SQLite via adapters)

## SDK Type Patterns

When working with external SDKs (Claude Agent SDK, Codex SDK), prefer importing and using SDK types directly:

```typescript
// CORRECT - Import SDK types directly
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';

const options: Options = {
  cwd,
  permissionMode: 'bypassPermissions',
  // ...
};

// Use type assertions for SDK response structures
const message = msg as { message: { content: ContentBlock[] } };
```

```typescript
// AVOID - Defining duplicate types
interface MyQueryOptions {  // Don't duplicate SDK types
  cwd: string;
  // ...
}
const options: MyQueryOptions = { ... };
query({ prompt, options: options as any });  // Avoid 'as any'
```

This ensures type compatibility with SDK updates and eliminates `as any` casts.

## Logging

**Structured logging with Pino** (`packages/paths/src/logger.ts`):

```typescript
import { createLogger } from '@archon/paths';

const log = createLogger('orchestrator');

// Event naming: {domain}.{action}_{state}
// Standard states: _started, _completed, _failed, _validated, _rejected
async function createSession(conversationId: string, codebaseId: string) {
  log.info({ conversationId, codebaseId }, 'session.create_started');

  try {
    const session = await doCreate();
    log.info({ conversationId, codebaseId, sessionId: session.id }, 'session.create_completed');
    return session;
  } catch (e) {
    const err = e as Error;
    log.error(
      { conversationId, error: err.message, errorType: err.constructor.name, err },
      'session.create_failed',
    );
    throw err;
  }
}
```

**Event naming rules:**
- Format: `{domain}.{action}_{state}` — e.g. `workflow.step_started`, `isolation.create_failed`
- Avoid generic events like `processing` or `handling`
- Always pair `_started` with `_completed` or `_failed`
- Include context: IDs, durations, error details

**Log Levels:** `fatal` > `error` > `warn` > `info` (default) > `debug` > `trace`

**Verbosity:**
- CLI: `archon --quiet` (errors only) — suppresses Pino logs and workflow progress output
- CLI: `archon --verbose` (debug) — enables debug Pino logs and tool-level workflow progress events
- Server: `LOG_LEVEL=debug bun run start`

**Never log:** API keys or tokens (mask: `token.slice(0, 8) + '...'`), user message content, PII.
