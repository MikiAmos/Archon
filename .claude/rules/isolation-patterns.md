# Isolation Architecture Patterns

## Core Design

- ALL isolation logic is centralized in the orchestrator — adapters are thin
- Every @mention auto-creates a worktree (simplicity > efficiency; worktrees are cheap)
- Data model is work-centric (`isolation_environments` table), enabling cross-platform sharing
- Cleanup is a separate service using git-first checks

## Directory Structure

```
~/.archon/workspaces/owner/repo/
├── source/          # Clone or symlink to local path
├── worktrees/       # Git worktrees for this project
├── artifacts/       # Workflow artifacts (NEVER in git)
│   ├── runs/{id}/   # Per-run artifacts ($ARTIFACTS_DIR)
│   └── uploads/{convId}/  # Web UI file uploads (ephemeral)
└── logs/            # Workflow execution logs
```

## Resolution Flow

1. Adapter provides `IsolationHints` (conversationId, workflowId, branch preference)
2. Orchestrator's `validateAndResolveIsolation()` resolves hints → environment
3. WorktreeProvider creates worktree if needed, syncs with origin first
4. Environment tracked in `isolation_environments` table

## Key Packages

- `@archon/isolation` (`packages/isolation/src/`) — types, providers, resolver, error classifiers
- `@archon/git` (`packages/git/src/`) — branch, worktree, repo operations
- `@archon/paths` (`packages/paths/src/`) — path resolution utilities

## Running the App in Worktrees

Agents working in worktrees can run the app for self-testing (make changes -> run app -> test via curl -> fix). Ports are automatically allocated to avoid conflicts:

```bash
# Run in worktree (port auto-allocated based on path)
bun dev &
# [Hono] Worktree detected (/path/to/worktree)
# [Hono] Auto-allocated port: 3637 (base: 3090, offset: +547)

# Test via web API (production path)
# 1) Create a conversation
curl -X POST http://localhost:3637/api/conversations \
  -H "Content-Type: application/json" \
  -d '{}'

# 2) Send a message
curl -X POST http://localhost:3637/api/conversations/<conversationId>/message \
  -H "Content-Type: application/json" \
  -d '{"message":"/status"}'

# 3) Fetch messages (polling)
curl http://localhost:3637/api/conversations/<conversationId>/messages

# Note: SSE streaming is available at /api/stream/<conversationId>
```

**Port Allocation:**
- Worktrees: Automatic unique port (3190-4089 range, hash-based on path)
- Main repo: Default 3090
- Override: `PORT=4000 bun dev` (works in both contexts)
- Same worktree always gets same port (deterministic)

**Important:**
- Use the web API routes for manual validation (avoid running multiple platform adapters)
- Database is shared (same conversations/codebases available)
- Kill the server when done: `pkill -f "bun.*dev"` or use the specific port

## Archon Home Directory

```
~/.archon/
├── workspaces/owner/repo/        # (see Directory Structure above)
├── vendor/codex/                  # Codex native binary (binary builds, user-placed)
├── web-dist/<version>/            # Cached web UI dist (archon serve, binary only)
├── update-check.json              # Update check cache (binary builds, 24h TTL)
├── archon.db                     # SQLite database (when DATABASE_URL not set)
└── config.yaml                   # Global configuration (non-secrets)
```

**Repo-level (`.archon/` in any repository):**
```
.archon/
├── commands/       # Custom commands
├── workflows/      # Workflow definitions (YAML files)
├── scripts/        # Named scripts for script: nodes
└── config.yaml     # Repo-specific configuration
```

- `ARCHON_HOME` overrides the base directory (default: `~/.archon`)
- Docker: Paths automatically set to `/.archon/`

## Safety Rules

- NEVER run `git clean -fd` — permanently deletes untracked files
- Use `classifyIsolationError()` to map git errors to user-friendly messages
- Trust git's natural guardrails (refuse to remove worktree with uncommitted changes)
- Use `execFileAsync` (not `exec`) when calling git directly
