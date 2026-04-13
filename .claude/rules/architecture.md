---
paths:
  - "packages/*/package.json"
  - "packages/*/src/index.ts"
  - "package.json"
---

# Monorepo Architecture

**Bun Workspaces layout:**

```
packages/
├── cli/                      # @archon/cli - Command-line interface
│   └── src/
│       ├── adapters/         # CLI adapter (stdout output)
│       ├── commands/         # CLI command implementations
│       └── cli.ts            # CLI entry point
├── core/                     # @archon/core - Shared business logic
│   └── src/
│       ├── clients/          # AI SDK clients (Claude, Codex)
│       ├── config/           # YAML config loading
│       ├── db/               # Database connection, queries
│       ├── handlers/         # Command handler (slash commands)
│       ├── orchestrator/     # AI conversation management
│       ├── services/         # Background services (cleanup)
│       ├── state/            # Session state machine
│       ├── types/            # TypeScript types and interfaces
│       ├── utils/            # Shared utilities
│       ├── workflows/        # Store adapter (createWorkflowStore) bridging core DB -> IWorkflowStore
│       └── index.ts          # Package exports
├── workflows/                # @archon/workflows - Workflow engine (depends on @archon/git + @archon/paths)
│   └── src/
│       ├── schemas/          # Zod schemas for engine types
│       ├── loader.ts         # YAML parsing + validation (parseWorkflow)
│       ├── workflow-discovery.ts # Workflow filesystem discovery
│       ├── executor-shared.ts # Shared executor infrastructure
│       ├── router.ts         # Prompt building + invocation parsing
│       ├── executor.ts       # Workflow execution orchestrator
│       ├── dag-executor.ts   # DAG-specific execution logic
│       ├── store.ts          # IWorkflowStore interface
│       ├── deps.ts           # WorkflowDeps injection types
│       ├── event-emitter.ts  # Workflow observability events
│       ├── logger.ts         # JSONL file logger
│       ├── validator.ts      # Resource validation
│       ├── defaults/         # Bundled default commands and workflows
│       └── utils/            # Variable substitution, tool formatting
├── git/                      # @archon/git - Git operations (no @archon/core dep)
│   └── src/
│       ├── branch.ts         # Branch operations
│       ├── exec.ts           # execFileAsync and mkdirAsync wrappers
│       ├── repo.ts           # Repository operations
│       ├── types.ts          # Branded types (RepoPath, BranchName, etc.)
│       ├── worktree.ts       # Worktree operations
│       └── index.ts          # Package exports
├── isolation/                # @archon/isolation - Worktree isolation (depends on @archon/git + @archon/paths)
│   └── src/
│       ├── types.ts          # Isolation types and interfaces
│       ├── errors.ts         # Error classifiers
│       ├── factory.ts        # Provider factory
│       ├── resolver.ts       # IsolationResolver
│       ├── store.ts          # IIsolationStore interface
│       ├── worktree-copy.ts  # File copy utilities
│       ├── providers/
│       │   └── worktree.ts   # WorktreeProvider implementation
│       └── index.ts          # Package exports
├── paths/                    # @archon/paths - Path resolution and logger (zero @archon/* deps)
│   └── src/
│       ├── archon-paths.ts   # Archon directory path utilities
│       ├── logger.ts         # Pino logger factory
│       └── index.ts          # Package exports
├── adapters/                 # @archon/adapters - Platform adapters (Slack, Telegram, GitHub, Discord)
│   └── src/
│       ├── chat/             # Chat platform adapters (Slack, Telegram)
│       ├── forge/            # Forge adapters (GitHub)
│       ├── community/        # Community adapters (Discord)
│       ├── utils/            # Shared adapter utilities
│       └── index.ts          # Package exports
├── server/                   # @archon/server - HTTP server + Web adapter
│   └── src/
│       ├── adapters/         # Web platform adapter (SSE streaming)
│       ├── routes/           # API routes (REST + SSE)
│       └── index.ts          # Hono server entry point
└── web/                      # @archon/web - React frontend (Web UI)
    └── src/
        ├── components/       # React components (chat, layout, projects, ui, workflows)
        ├── hooks/            # Custom hooks (useSSE, etc.)
        ├── lib/              # API client, types, utilities
        ├── stores/           # Zustand stores (workflow-store)
        ├── routes/           # Route pages
        └── App.tsx           # Router + layout
```

## Package Dependency Graph

```
@archon/paths           (zero @archon/* deps)
  └── @archon/git       (depends on @archon/paths)
       ├── @archon/isolation  (depends on @archon/git + @archon/paths)
       └── @archon/workflows  (depends on @archon/git + @archon/paths + zod; DB/AI injected via WorkflowDeps)
            └── @archon/core  (business logic, DB, orchestration, AI clients; provides createWorkflowStore() adapter)
                 └── @archon/adapters  (platform adapters for Slack, Telegram, GitHub, Discord)
                      └── @archon/server  (OpenAPIHono HTTP server, Web adapter, API routes)
                           └── @archon/cli  (CLI entry point, depends on @archon/server + @archon/adapters)

@archon/web  (React frontend, standalone — types from generated OpenAPI spec, never imports @archon/workflows)
```
