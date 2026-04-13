---
paths:
  - ".archon/config.yaml"
  - "packages/core/src/config/**/*.ts"
  - "packages/workflows/src/loader.ts"
---

# Configuration

**Environment Variables:** see `.env.example` and `.archon/config.yaml` setup as needed.

## Assistant Defaults

Configure default models and options per assistant in `.archon/config.yaml`:

```yaml
assistants:
  claude:
    model: sonnet  # or 'opus', 'haiku', 'claude-*', 'inherit'
    settingSources:  # Controls which CLAUDE.md files Claude SDK loads
      - project      # Default: only project-level CLAUDE.md
      - user         # Optional: also load ~/.claude/CLAUDE.md
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: medium  # 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    webSearchMode: live  # 'disabled' | 'cached' | 'live'
    additionalDirectories:
      - /absolute/path/to/other/repo
    codexBinaryPath: /usr/local/bin/codex  # Optional: custom Codex CLI binary path

# docs:
#   path: docs  # Optional: default is docs/
```

## Configuration Priority

1. Workflow-level options (in YAML `model`, `modelReasoningEffort`, etc.)
2. Config file defaults (`.archon/config.yaml` `assistants.*`)
3. SDK defaults

## Model Validation

- Workflows are validated at load time for provider/model compatibility
- Claude models: `sonnet`, `opus`, `haiku`, `claude-*`, `inherit`
- Codex models: Any model except Claude-specific aliases
- Invalid combinations fail workflow loading with clear error messages
